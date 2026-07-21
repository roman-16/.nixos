import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { deliver, onAssistantText, onRunError } from "./agent";
import type { ChatStore } from "./chat-store";
import type { Config } from "./config";
import type { Kv } from "./kv";
import { createThrottle, type LogStore, shouldNotify } from "./logs";
import {
  claudeErrorNotice,
  compactionNotice,
  formatLogNotice,
  isAllowed,
  jidForNumber,
  skillContextNote,
  voiceText,
} from "./messages";
import { dayBoundaryNotes, withContext } from "./newday";
import { quotedContextNote } from "./quoted";
import { transcribeAudio } from "./transcribe";
import type { InboundMessage, WhatsApp, WhatsAppState } from "./whatsapp";

const DISCONNECTED: WhatsAppState = { qr: undefined, status: "connecting", user: undefined };

/** Keep the WhatsApp "typing…" indicator alive between refreshes for ~8 minutes at most. */
const TYPING_REFRESH_MS = 4000;
const TYPING_MAX_TICKS = 120;

export interface PipelineDeps {
  chatStore: ChatStore;
  config: Config;
  kv: Kv;
  logStore: LogStore;
  logger: Logger;
  session: AgentSession;
}

/** The bridge between WhatsApp and the pi session: inbound prompts, outbound replies, the typing indicator, and proactive notices. */
export interface Pipeline {
  /** Bind the live socket once WhatsApp has connected. */
  attach(socket: WhatsApp): void;
  /** Deliver a skill-originated message to the user out of band: send it, record it in the chat DB, and queue a [context] note for the agent's next turn. */
  emitSkillMessage(text: string, source: string): Promise<void>;
  /** Handle a (re)connect: apply the configured profile picture if it changed. */
  handleConnect(): void;
  /** Handle one allowlisted inbound message: transcribe, add day context, and prompt the session. */
  handleInbound(message: InboundMessage): Promise<void>;
  /** Best-effort proactive message to the user; silently drops when not connected. */
  notify(text: string): Promise<void>;
  /** Drop the current session and re-issue a QR. */
  relink(): void;
  /** Deliver to the user, rejecting when not connected so the caller can retry (reminders). */
  sendToUser(text: string): Promise<void>;
  /** The current WhatsApp link state, or a disconnected placeholder before the socket attaches. */
  state(): WhatsAppState;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { chatStore, config, kv, logStore, logger, session } = deps;

  let socket: WhatsApp | undefined;
  let target: string | undefined;
  // A proactive notice can fire before any inbound sets `target` (e.g. a compaction right after a
  // restart), so fall back to the primary allowlisted number.
  const fallbackTarget = config.allowFrom[0] ? jidForNumber(config.allowFrom[0]) : undefined;
  const recipient = () => target ?? fallbackTarget;
  const connected = () => Boolean(socket) && socket!.getState().status === "connected";

  // Hold the "typing…" indicator up from the moment a message arrives until the session settles.
  // WhatsApp drops it on every outbound message and auto-expires it after a few seconds, so it is
  // re-asserted after each send (below) and on a short refresh loop.
  let typingTimer: ReturnType<typeof setInterval> | undefined;

  function sendComposing(): void {
    if (socket && target) void socket.presence(target, "composing");
  }

  function stopTyping(): void {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
    if (socket && target) void socket.presence(target, "paused");
  }

  function startTyping(): void {
    stopTyping();
    if (!socket || !target) return;
    sendComposing();
    let ticks = 0;
    typingTimer = setInterval(() => {
      if (!socket || !target || (ticks += 1) > TYPING_MAX_TICKS) {
        stopTyping();
        return;
      }
      sendComposing();
    }, TYPING_REFRESH_MS);
  }

  async function sendToUser(text: string): Promise<void> {
    const to = recipient();
    if (!socket || !to || !connected()) throw new Error("whatsapp not connected");
    await socket.send(to, text);
  }

  async function notify(text: string): Promise<void> {
    try {
      await sendToUser(text);
    } catch (error) {
      logger.debug({ error }, "notify send failed");
    }
  }

  // Notes about out-of-band skill sends since the agent's last turn, persisted (survives restarts)
  // and capped, drained into the next inbound prompt as [context] lines.
  const SKILL_NOTES_MAX = 10;

  function readSkillNotes(): string[] {
    try {
      const parsed: unknown = JSON.parse(kv.get("skillNotes") ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [];
    }
  }

  function drainSkillNotes(): string[] {
    const notes = readSkillNotes();
    if (notes.length > 0) kv.set("skillNotes", "[]");
    return notes;
  }

  // Deliver a message a skill produced (a fired reminder, a macros reply) directly to the user,
  // record it in the chat DB as a "via <source>" bubble, and queue a [context] note so the agent
  // learns about it next turn. Send first, so a failed send (the reminder watcher retries) never
  // logs or contexts a message the user never received.
  async function emitSkillMessage(text: string, source: string): Promise<void> {
    await sendToUser(text);
    try {
      chatStore.appendSkillMessage(session.sessionId, source, text);
    } catch (error) {
      logger.error({ error }, "skill message chat-log append failed");
    }
    kv.set(
      "skillNotes",
      JSON.stringify([...readSkillNotes(), skillContextNote(source, text)].slice(-SKILL_NOTES_MAX)),
    );
    if (typingTimer) sendComposing(); // a send clears the recipient's indicator; re-assert if mid-turn
  }

  // Fan every warn+ log line out to WhatsApp - the log level is the single source of truth for
  // "worth interrupting the user". Deduped so a burst can't spam, and guarded against re-entrancy so
  // a send that itself logs (or Baileys chatter emitted mid-send) can't loop back in.
  const notifyThrottle = createThrottle(config.notifyThrottleMs);
  let notifying = false;
  logStore.onRecord = (record) => {
    if (notifying || !shouldNotify(record, config.notifyLevel)) return;
    const to = recipient();
    if (!socket || !to || !connected()) return;
    const text =
      typeof record.notifyText === "string" ? record.notifyText : formatLogNotice(record);
    if (!notifyThrottle(text)) return;
    notifying = true;
    void socket
      .send(to, text)
      .catch((error) => logger.debug({ error }, "notify send failed"))
      .finally(() => {
        notifying = false;
      });
  };

  // Each finished assistant text block is sent the instant it completes, so a short lead line reads
  // naturally. Sending clears the indicator on the recipient's side, so re-assert it while working.
  onAssistantText(session, (text) => {
    if (!socket || !target) return;
    void socket
      .send(target, text)
      .then(() => {
        if (typingTimer) sendComposing();
      })
      .catch((error) => logger.error({ error }, "send failed"));
  });

  session.subscribe((event) => {
    if (event.type === "agent_settled") stopTyping();
    if (event.type === "compaction_end" && event.result && !event.aborted) {
      void notify(compactionNotice(event.result.tokensBefore));
    }
  });

  // A run that ends in a terminal LLM error produces no text block, so log it at error - the
  // notifier above delivers the friendly notice from notifyText.
  onRunError(session, (detail) => {
    logger.error({ detail, notifyText: claudeErrorNotice(detail) }, "claude run error");
  });

  // On (re)connect set the bot's avatar from the configured image, uploading only when it changes
  // (its hash is tracked in kv) so routine reconnects don't re-upload.
  async function applyProfilePicture(): Promise<void> {
    if (!socket || !config.profilePicturePath) return;
    let image: Buffer;
    try {
      image = await readFile(config.profilePicturePath);
    } catch (error) {
      logger.warn({ error }, "profile picture unreadable");
      return;
    }
    const hash = createHash("sha256").update(image).digest("hex");
    if (kv.get("profilePictureHash") === hash) return;
    try {
      await socket.setProfilePicture(image);
      kv.set("profilePictureHash", hash);
      logger.info("profile picture applied");
    } catch (error) {
      logger.warn({ error }, "failed to set profile picture");
    }
  }

  async function transcribe(message: InboundMessage): Promise<string | undefined> {
    if (!message.audio) return message.text;
    try {
      return voiceText(
        await transcribeAudio(message.audio.data, {
          apiKey: config.mistralApiKey,
          model: config.transcribeModel,
        }),
      );
    } catch (error) {
      logger.error({ error }, "transcription failed");
      stopTyping();
      void socket?.send(
        message.from,
        `🎤 Couldn't transcribe that voice note: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }
  }

  // Turn a reply-quote into a [context] note: transcribe a quoted voice note (best-effort;
  // a failure falls back to a bare "voice message" label) and pass its downloaded image(s)
  // through to the turn so the agent can see what's being referenced.
  async function resolveQuoted(
    quoted: NonNullable<InboundMessage["quoted"]>,
  ): Promise<{ images: ImageContent[]; note: string }> {
    let { text } = quoted;
    if (quoted.audio) {
      try {
        text = await transcribeAudio(quoted.audio.data, {
          apiKey: config.mistralApiKey,
          model: config.transcribeModel,
        });
      } catch (error) {
        logger.warn({ error }, "quoted voice transcription failed");
        text = "";
      }
    }
    const note = quotedContextNote({
      attached: quoted.images.length > 0,
      kind: quoted.kind,
      sender: quoted.sender,
      text,
    });
    return { images: quoted.images, note };
  }

  return {
    attach(next) {
      socket = next;
    },
    emitSkillMessage,
    handleConnect() {
      void applyProfilePicture();
    },
    async handleInbound(message) {
      if (!isAllowed(message.number, config.allowFrom)) {
        logger.warn({ from: message.number }, "ignored message from non-allowlisted number");
        return;
      }
      target = message.from;
      void socket?.read(message.key); // blue checkmarks so the user knows it arrived
      startTyping();

      const text = await transcribe(message);
      if (text === undefined) return; // transcription failed and already reported

      const prompt = text || "(image)";
      const lastInbound = kv.get("lastInboundAt");
      const dayNotes = dayBoundaryNotes(
        lastInbound ? new Date(Number(lastInbound)) : undefined,
        new Date(),
        config.dayStartHour,
      );
      kv.set("lastInboundAt", String(Date.now()));

      const notes = [...dayNotes, ...drainSkillNotes()];
      let images = message.images;
      if (message.quoted) {
        const resolved = await resolveQuoted(message.quoted);
        notes.push(resolved.note);
        images = [...images, ...resolved.images];
      }

      logger.info(
        {
          chars: prompt.length,
          dayNotes: dayNotes.length,
          from: message.number,
          images: images.length,
          quoted: message.quoted?.kind,
          voice: Boolean(message.audio),
        },
        "prompt",
      );
      try {
        await deliver(session, withContext(notes, prompt), images);
      } catch (error) {
        logger.error({ error }, "prompt failed");
        stopTyping();
        void socket?.send(
          message.from,
          `⚠️ ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    notify,
    relink() {
      socket?.relink();
    },
    sendToUser,
    state() {
      return socket ? socket.getState() : DISCONNECTED;
    },
  };
}
