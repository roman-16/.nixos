import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import { type AgentSession, resizeImage } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

import { conversationTokens, deliver, onAssistantText, onRunError } from "./agent";
import type { Anthropic, AnthropicStatus } from "./anthropic";
import type { Attachment } from "./attachments";
import { buildBacklog } from "./backlog";
import type { ChatStore } from "./chat-store";
import { type CompactionReason, compactionReason } from "./compaction-schedule";
import type { Config } from "./config";
import { droppedImageNote, fitImages } from "./images";
import type { Admission, Inbox, InboxEntry } from "./inbox";
import type { Kv } from "./kv";
import type { MemoryFolder } from "./memory";
import { foldReason } from "./memory-schedule";
import { createThrottle, type LogStore, shouldNotify } from "./logs";
import {
  claudeAuthNotice,
  claudeErrorNotice,
  fileContextNote,
  fileMark,
  formatLogNotice,
  isAllowed,
  jidForNumber,
  linkGapNote,
  skillContextNote,
  splitInternal,
  voiceFailure,
  voiceText,
} from "./messages";
import { quotedContextNote } from "./quoted";
import { type ContextNote, timeContext, withContext } from "./temporal";
import { transcribeAudio } from "./transcribe";
import type { InboundMessage, WhatsApp, WhatsAppState } from "./whatsapp";

/** Keep the WhatsApp "typing…" indicator alive between refreshes for ~8 minutes at most. */
const TYPING_REFRESH_MS = 4000;
const TYPING_MAX_TICKS = 120;

/** How often the link's liveness is stamped, so a gap survives a restart or a dead VM. */
const HEARTBEAT_MS = 60_000;

/** Pause before a failed delivery is retried, so a persistent fault can't spin on the backlog. */
const DELIVERY_RETRY_MS = 5 * 60_000;

/** Sweep for anything still owed - covers rows placed in the inbox out of band. */
const DRAIN_TICK_MS = 60_000;

/** How often Apollo asks itself whether the conversation is quiet enough for maintenance. */
const MAINTENANCE_TICK_MS = 60_000;

/** Pause after a failed compaction or fold, so a failing one cannot spin on the tick. */
const MAINTENANCE_RETRY_MS = 10 * 60_000;

const LINK_ALIVE_KEY = "linkAliveAt";
const LINK_GAP_KEY = "linkGap";
const LAST_SENT_KEY = "lastInboundSentAt";
const LAST_COMPACTED_KEY = "lastCompactedAt";
const MEMORY_FOLDED_AT_KEY = "memoryFoldedAt";

/** How each verdict on an inbound message reads in the log. */
const ADMISSION_LOG: Record<Admission, string> = {
  admitted: "message admitted",
  duplicate: "message already seen",
  expired: "a message older than the inbox horizon was dropped unanswered",
};

/** A window in which Apollo was off WhatsApp, owed to its next turn. */
interface LinkGap {
  from: number;
  to: number;
}

function isContextNote(value: unknown): value is ContextNote {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Record<string, unknown>;
  return (
    typeof note.body === "string" &&
    typeof note.info === "string" &&
    typeof note.source === "string"
  );
}

export interface PipelineDeps {
  anthropic: Anthropic;
  chatStore: ChatStore;
  config: Config;
  inbox: Inbox;
  kv: Kv;
  logStore: LogStore;
  logger: Logger;
  memory: MemoryFolder;
  session: AgentSession;
}

/** The bridge between WhatsApp and the pi session: inbound prompts, outbound replies, the typing indicator, and proactive notices. */
export interface Pipeline {
  /** Bind the live socket once WhatsApp has connected. */
  attach(socket: WhatsApp): void;
  /** Deliver a skill-originated message to the user out of band: send it, record it in the chat DB, and queue a context note for the agent's next turn. Text alone, or a picture or file with `text` as its caption. */
  emitSkillMessage(text: string, source: string, attachment?: Attachment): Promise<void>;
  /** Handle a (re)connect: note any gap, apply the profile picture, and deliver what is owed. */
  handleConnect(): void;
  /** Take a delivery from WhatsApp into the durable inbox, then hand over whatever is owed. */
  handleInbound(messages: InboundMessage[]): Promise<void>;
  /** Best-effort proactive message to the user; silently drops when not connected. */
  notify(text: string): Promise<void>;
  /** Drop the current session and re-issue a QR. */
  relink(): void;
  /** Deliver to the user, rejecting when not connected so the caller can retry (reminders). */
  sendToUser(text: string, attachment?: Attachment): Promise<void>;
  /** The current WhatsApp link state, or a disconnected placeholder before the socket attaches. */
  state(): WhatsAppState;
}

export function createPipeline(deps: PipelineDeps): Pipeline {
  const { anthropic, chatStore, config, inbox, kv, logStore, logger, memory, session } = deps;

  const startedAt = Date.now();
  const disconnected: WhatsAppState = {
    downSince: startedAt,
    qr: undefined,
    status: "connecting",
    user: undefined,
  };

  let socket: WhatsApp | undefined;
  let target: string | undefined;
  // A proactive notice can fire before any inbound sets `target` (e.g. a compaction right after a
  // restart), so fall back to the primary allowlisted number.
  const fallbackTarget = config.allowFrom[0] ? jidForNumber(config.allowFrom[0]) : undefined;
  const recipient = () => target ?? fallbackTarget;
  const connected = () => Boolean(socket) && socket!.getState().status === "connected";

  // Only one drain runs at a time, and a failed delivery pauses the next one until `retryAfter`.
  let draining = false;
  let retryAfter = 0;

  // When the conversation last moved, so maintenance can wait for a gap rather than for a full window.
  let lastActivityAt = startedAt;
  let lastCompactAttemptAt = 0;
  let lastFoldFailureAt = 0;
  let maintaining = false;

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

  async function sendToUser(text: string, attachment?: Attachment): Promise<void> {
    const to = recipient();
    if (!socket || !to || !connected()) throw new Error("whatsapp not connected");
    if (attachment) await socket.sendMedia(to, attachment, text);
    else await socket.send(to, text);
  }

  async function notify(text: string): Promise<void> {
    try {
      await sendToUser(text);
    } catch (error) {
      logger.debug({ error }, "notify send failed");
    }
  }

  // Notes about out-of-band skill sends since the agent's last turn, persisted (survives restarts)
  // and capped, drained into the next inbound prompt as <context> elements.
  const SKILL_NOTES_MAX = 10;

  function readSkillNotes(): ContextNote[] {
    try {
      const parsed: unknown = JSON.parse(kv.get("skillNotes") ?? "[]");
      return Array.isArray(parsed) ? parsed.filter(isContextNote) : [];
    } catch {
      return [];
    }
  }

  function clearSkillNotes(): void {
    kv.set("skillNotes", "[]");
  }

  // The gap since Apollo was last reachable on WhatsApp, kept until a turn carries it. Persisted like
  // the skill notes, so a restart straight after the reconnect does not lose it.
  function readLinkGap(): LinkGap | undefined {
    try {
      const parsed: unknown = JSON.parse(kv.get(LINK_GAP_KEY) ?? "null");
      if (typeof parsed !== "object" || parsed === null) return undefined;
      const { from, to } = parsed as Record<string, unknown>;
      return typeof from === "number" && typeof to === "number" ? { from, to } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Record a gap, merged with one still owed: a flapping link is one window, not ten notes. */
  function noteLinkGap(gap: LinkGap): void {
    const owed = readLinkGap();
    kv.set(
      LINK_GAP_KEY,
      JSON.stringify(
        owed ? { from: Math.min(owed.from, gap.from), to: Math.max(owed.to, gap.to) } : gap,
      ),
    );
  }

  function clearLinkGap(): void {
    kv.remove(LINK_GAP_KEY);
  }

  // Deliver a message a skill produced (a fired reminder, a macros reply, a rendered diagram, a
  // file) directly to the user, record it in the chat DB as a "via <source>" bubble, and queue a
  // context note so the agent learns about it next turn. Send first, so a failed send (the reminder
  // watcher retries) never logs or contexts a message the user never received.
  async function emitSkillMessage(
    text: string,
    source: string,
    attachment?: Attachment,
  ): Promise<void> {
    await sendToUser(text, attachment);
    try {
      chatStore.appendSkillMessage(session.sessionId, source, text, attachment ? [attachment] : []);
    } catch (error) {
      logger.error({ error }, "skill message chat-log append failed");
    }
    kv.set(
      "skillNotes",
      JSON.stringify(
        [...readSkillNotes(), skillContextNote(source, text, attachment?.kind)].slice(
          -SKILL_NOTES_MAX,
        ),
      ),
    );
    if (typingTimer) sendComposing(); // a send clears the recipient's indicator; re-assert if mid-turn
  }

  /**
   * Say once, and in words the user can act on, that Claude is out of reach until they renew the
   * sign-in. Every path that discovers a dead credential retires it, so watching the status is enough
   * to catch all of them - including the nightly memory fold, which discovers it with nobody about,
   * and the startup probe, which runs before this pipeline exists.
   *
   * A sign-in that was never set up is not news: that is a setup step, and the dashboard is where it
   * is done. An expiry is, so it goes out the way an outage does - recorded in the chat, so the gap
   * it explains is still explained to Apollo once it can read again - and is held onto until it has
   * actually been delivered rather than being lost to a WhatsApp link that was not up yet.
   */
  let announced: AnthropicStatus | undefined;
  function announceClaude(): void {
    const status = anthropic.status();
    if (status === announced) return;
    if (status !== "expired") {
      announced = status;
      return;
    }
    void emitSkillMessage(claudeAuthNotice(config.dashboardUrl), "status").then(
      () => {
        announced = status;
      },
      (error: unknown) => logger.debug({ error }, "claude notice not delivered yet"),
    );
  }

  // Fan every warn+ log line out to WhatsApp - the log level is the single source of truth for
  // "worth interrupting the user". Deduped so a burst can't spam, and guarded against re-entrancy so
  // a send that itself logs (or Baileys chatter emitted mid-send) can't loop back in.
  const notifyThrottle = createThrottle(config.notifyThrottleMs);
  let notifying = false;
  logStore.onRecord = (record) => {
    if (notifying || !shouldNotify(record, config.notifyLevel)) return;
    // While there is no sign-in, every warning is a symptom of the one thing the user has already
    // been told about, in a message that says what to do about it. Repeating the symptoms would only
    // bury it.
    if (anthropic.status() !== "connected") return;
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
  // What Apollo marked internal stays behind, and a block that was nothing but such a note sends
  // nothing: that is how a turn ends in silence.
  onAssistantText(session, (text) => {
    const { delivered } = splitInternal(text);
    if (!socket || !target || !delivered) return;
    void socket
      .send(target, delivered)
      .then(() => {
        if (typingTimer) sendComposing();
      })
      .catch((error) => logger.error({ error }, "send failed"));
  });

  session.subscribe((event) => {
    if (event.type === "agent_settled") {
      stopTyping();
      lastActivityAt = Date.now();
    }
    // Compaction is maintenance, not news: it is recorded on the dashboard and never messaged to
    // the user, who would otherwise be woken by the nightly one.
    if (event.type === "compaction_end" && event.result && !event.aborted) {
      kv.set(LAST_COMPACTED_KEY, String(Date.now()));
      logger.info({ tokensBefore: event.result.tokensBefore }, "compacted");
    }
  });

  /** Whether the session is free for maintenance work right now. */
  function quiet(): boolean {
    if (!session.isIdle || session.isCompacting || session.isStreaming) return false;
    // Summarizing and folding are model calls, so without a sign-in they are guaranteed-failing ones.
    if (anthropic.status() !== "connected") return false;
    return inbox.pending(1).length === 0;
  }

  /** A timestamp kept in kv, or undefined when it has never been set. */
  function kvTime(key: string): number | undefined {
    const value = Number(kv.get(key) ?? 0);
    return value > 0 ? value : undefined;
  }

  /**
   * Compact when the conversation has gone quiet, not when the window is full. A full window is the
   * most expensive and least accurate moment there is, and it always arrives mid-task; a gap costs
   * nothing, since nobody is waiting and the prompt cache is expiring regardless.
   */
  async function maybeCompact(): Promise<void> {
    // Stamped per attempt, not per failure: a single turn too large to cut leaves the conversation
    // over the threshold, and without this it would be summarized again every tick.
    if (Date.now() - lastCompactAttemptAt < MAINTENANCE_RETRY_MS) return;
    const tokens = conversationTokens(session);
    const reason: CompactionReason | undefined = compactionReason(
      {
        conversationTokens: tokens,
        idleMs: Date.now() - lastActivityAt,
        lastCompactedAt: kvTime(LAST_COMPACTED_KEY),
        now: Date.now(),
      },
      {
        atTokens: config.compactAtTokens,
        dayStartHour: config.dayStartHour,
        idleMs: config.compactIdleMs,
        nightlyFloorTokens: config.compactNightlyTokens,
      },
    );
    if (!reason) return;
    lastCompactAttemptAt = Date.now();
    logger.info({ reason, tokens }, "compacting");
    try {
      await session.compact();
    } catch (error) {
      anthropic.observe(error instanceof Error ? error.message : String(error));
      logger.warn({ error }, "compaction failed");
    }
  }

  /**
   * Fold what has been said since the last fold into MEMORY.md. A compaction asks for it (the raw
   * conversation is about to stop being visible, and the summary never carries the profile), and so
   * does a new day (a quiet week never compacts, and the profile would never be maintained).
   */
  async function maybeFoldMemory(): Promise<void> {
    if (Date.now() - lastFoldFailureAt < MAINTENANCE_RETRY_MS) return;
    const reason = foldReason(
      {
        foldedAt: kvTime(MEMORY_FOLDED_AT_KEY),
        idleMs: Date.now() - lastActivityAt,
        lastCompactedAt: kvTime(LAST_COMPACTED_KEY),
        now: Date.now(),
      },
      { dayStartHour: config.dayStartHour, idleMs: config.compactIdleMs },
    );
    if (!reason) return;
    if (await memory.fold(reason)) kv.set(MEMORY_FOLDED_AT_KEY, String(Date.now()));
    else lastFoldFailureAt = Date.now();
  }

  // One tick for both, in order and never overlapping: a fold reads the branch a compaction is
  // rewriting, and it wants the compaction's own timestamp to fold against. Either can outlast the
  // tick, so a pass in flight owns the next ones until it is done.
  setInterval(() => {
    announceClaude();
    if (maintaining) return;
    maintaining = true;
    void (async () => {
      try {
        if (!quiet()) return;
        await maybeCompact();
        if (quiet()) await maybeFoldMemory();
      } finally {
        maintaining = false;
      }
    })();
  }, MAINTENANCE_TICK_MS);

  // A run that ends in a terminal LLM error produces no text block, so log it at error - the
  // notifier above delivers the friendly notice from notifyText. A refusal that means the sign-in
  // itself is finished is a different matter: it retires the credential, which both silences the
  // generic notice (nothing to retry) and hands the announcement to announceClaude.
  onRunError(session, (detail) => {
    anthropic.observe(detail);
    if (anthropic.status() !== "connected") {
      logger.error({ detail }, "claude sign-in expired");
      announceClaude();
      return;
    }
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

  // A voice note that cannot be transcribed still becomes a message: the agent is told what it was
  // and can ask, rather than the recording vanishing between WhatsApp and the session.
  async function transcribe(message: InboundMessage): Promise<string> {
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
      return voiceFailure();
    }
  }

  // Turn a reply-quote into a context note: transcribe a quoted voice note (best-effort;
  // a failure falls back to a bare "voice message" label) and pass its downloaded image(s)
  // through to the turn so the agent can see what's being referenced.
  async function resolveQuoted(
    quoted: NonNullable<InboundMessage["quoted"]>,
  ): Promise<{ images: ImageContent[]; note: ContextNote }> {
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

  /**
   * Turn the messages owed to the agent into one prompt: a single fresh message reads as itself,
   * anything else as a timestamped catch-up transcript. Either way the turn states when each message
   * was sent, so the agent never mistakes a queued message for a live one.
   */
  function buildTurn(batch: InboxEntry[]): { images: ImageContent[]; prompt: string } {
    const now = Date.now();
    const stored = Number(kv.get(LAST_SENT_KEY) ?? 0);
    const previous = stored > 0 ? stored : undefined;
    const images = batch.flatMap((entry) => entry.images);
    const carried = batch.flatMap((entry) => entry.contexts);
    // The clock first, then any hole in it, then what was delivered while the agent was away.
    const gap = readLinkGap();
    const owed = [...(gap ? [linkGapNote(gap.from, gap.to)] : []), ...readSkillNotes()];
    const single = batch.length === 1 ? batch[0] : undefined;
    if (single) {
      const note = timeContext({
        dayStartHour: config.dayStartHour,
        now,
        previous,
        sentAt: single.sentAt,
        staleMs: config.staleMs,
      });
      return { images, prompt: withContext([note, ...owed, ...carried], single.text || "(image)") };
    }
    const { note, text } = buildBacklog(
      batch.map((entry) => ({
        images: entry.images.length,
        sentAt: entry.sentAt,
        text: entry.text || "(image)",
      })),
      now,
    );
    return { images, prompt: withContext([note, ...owed, ...carried], text) };
  }

  /**
   * Hand the inbox's pending messages to the agent, oldest first, one turn at a time. The inbox is
   * the queue, so nothing is delivered into a running turn: a message that arrives mid-run stays
   * durable and joins the next batch. Nor is anything delivered without a link, since the agent's
   * reply would have nowhere to go - it waits, which is the whole point of the inbox. Without a
   * Claude sign-in there is no reply to be had at all, so the same applies: the messages stay owed
   * rather than being spent on turns that cannot answer them, and go out as one catch-up once it is
   * renewed. A delivery that throws leaves its messages pending and backs off, so a persistent fault
   * retries later instead of spinning.
   */
  async function drain(): Promise<void> {
    if (draining || !connected() || session.isStreaming || session.isCompacting) return;
    if (anthropic.status() !== "connected") return;
    if (Date.now() < retryAfter) return;
    draining = true;
    try {
      for (;;) {
        const batch = inbox.pending(config.backlogMax);
        if (batch.length === 0) return;
        const { images, prompt } = buildTurn(batch);
        logger.info(
          { chars: prompt.length, count: batch.length, images: images.length },
          batch.length > 1 ? "catch-up prompt" : "prompt",
        );
        startTyping();
        try {
          await deliver(session, prompt, images);
        } catch (error) {
          retryAfter = Date.now() + DELIVERY_RETRY_MS;
          logger.error({ error }, "prompt failed");
          stopTyping();
          void notify(`⚠️ ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        // A turn that died with the sign-in was never answered, so its messages are still owed.
        // onRunError condemns the credential while the run ends, before the delivery above resolves.
        if (anthropic.status() !== "connected") {
          stopTyping();
          return;
        }
        inbox.markHandled(batch.map((entry) => entry.waId));
        clearSkillNotes();
        clearLinkGap();
        kv.set(LAST_SENT_KEY, String(batch[batch.length - 1]!.sentAt));
      }
    } finally {
      draining = false;
    }
  }

  // Anything owed when a run ends (messages that arrived while the agent was working, or rows placed
  // in the inbox out of band) goes out as soon as the session is free again.
  session.subscribe((event) => {
    if (event.type === "agent_settled") void drain();
  });
  setInterval(() => void drain(), DRAIN_TICK_MS);

  // Stamp the link's liveness while it is up, so the length of an outage survives a restart or a
  // dead VM: on reconnect the gap is "now minus the last stamp", not "since this process started".
  setInterval(() => {
    if (connected()) kv.set(LINK_ALIVE_KEY, String(Date.now()));
  }, HEARTBEAT_MS);

  return {
    attach(next) {
      socket = next;
    },
    emitSkillMessage,
    handleConnect() {
      void applyProfilePicture();
      const aliveAt = Number(kv.get(LINK_ALIVE_KEY) ?? 0);
      const now = Date.now();
      kv.set(LINK_ALIVE_KEY, String(now));
      if (aliveAt > 0 && now - aliveAt > config.linkGraceMs) {
        logger.info({ ms: now - aliveAt, since: new Date(aliveAt).toISOString() }, "link gap");
        // Nothing is sent about it: whatever WhatsApp queued arrives as its own catch-up turn, which
        // says for itself that it was late, and a gap that queued nothing is indistinguishable from
        // one nobody wrote into. So the gap is only handed to the next turn, where it can answer for
        // the silence rather than interrupt to ask about it.
        noteLinkGap({ from: aliveAt, to: now });
      }
      void drain();
    },
    async handleInbound(messages) {
      const allowed: InboundMessage[] = [];
      for (const message of messages) {
        if (isAllowed(message.number, config.allowFrom)) allowed.push(message);
        else logger.warn({ from: message.number }, "ignored message from non-allowlisted number");
      }
      if (allowed.length === 0) return;
      lastActivityAt = Date.now();
      target = allowed[allowed.length - 1]!.from;
      for (const message of allowed) void socket?.read(message.key); // blue checkmarks
      startTyping();

      // Normalizing before admission means the stored message is exactly what the agent will see:
      // a transcript rather than audio, downloaded images, files already on disk, the quoted
      // message resolved.
      let admitted = 0;
      for (const message of allowed) {
        const spoken = await transcribe(message);
        const contexts: ContextNote[] = [];
        let raw = message.images;
        if (message.quoted) {
          const resolved = await resolveQuoted(message.quoted);
          contexts.push(resolved.note);
          raw = [...raw, ...resolved.images];
        }
        for (const file of message.files) {
          contexts.push(fileContextNote(file, config.fileRetentionDays));
          if (file.problem) {
            logger.warn(
              { name: file.name, problem: file.problem, size: file.size },
              "a file the user sent could not be taken",
            );
          }
        }
        const { dropped, images, resized } = await fitImages(raw, resizeImage);
        if (dropped > 0) logger.warn({ dropped }, "images could not be fitted for the model");
        // The file's name leads, because that is how the message reads on the phone: a document
        // bubble, and the caption under it.
        const text = [
          ...message.files.map((file) => fileMark(file.name)),
          spoken,
          droppedImageNote(dropped),
        ]
          .filter(Boolean)
          .join("\n")
          .trim();
        const admission = inbox.admit({
          contexts,
          files: message.files,
          images,
          sentAt: message.sentAt,
          text,
          waId: message.waId,
        });
        if (admission === "admitted") admitted += 1;
        // A message too old to answer is the one case where something the user sent is knowably
        // lost, so it warns like any other dropped content; the rest is bookkeeping.
        const level = admission === "expired" ? "warn" : "info";
        logger[level](
          {
            chars: text.length,
            files: message.files.length,
            from: message.number,
            images: images.length,
            offline: message.offline,
            quoted: message.quoted?.kind,
            resized,
            sentAt: new Date(message.sentAt).toISOString(),
            voice: Boolean(message.audio),
          },
          ADMISSION_LOG[admission],
        );
      }
      if (admitted === 0) {
        stopTyping();
        return;
      }
      await drain();
    },
    notify,
    relink() {
      socket?.relink();
    },
    sendToUser,
    state() {
      return socket ? socket.getState() : disconnected;
    },
  };
}
