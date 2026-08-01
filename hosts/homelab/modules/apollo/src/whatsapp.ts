import { rm } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  S_WHATSAPP_NET,
  useMultiFileAuthState,
  type WAMessage,
  type WAVersion,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import { numberFromJid, splitMessage } from "./messages";
import { describeQuotedMessage, type QuotedContext } from "./quoted";

type Socket = ReturnType<typeof makeWASocket>;
type Content = NonNullable<WAMessage["message"]>;
type QuotedInfo = NonNullable<NonNullable<Content["extendedTextMessage"]>["contextInfo"]>;

/** Reconnect backoff: doubles from this floor up to the ceiling below. */
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60_000;

/** Consecutive failed reconnects before a disconnect is logged at warn instead of info. */
const WARN_AFTER_ATTEMPTS = 3;

/** How long a successfully resolved WhatsApp Web version is reused before it is looked up again. */
const VERSION_TTL_MS = 6 * 60 * 60 * 1000;

/** Cap on the WhatsApp Web version lookup, so a hanging fetch never stalls a connection attempt. */
const VERSION_TIMEOUT_MS = 10_000;

/**
 * Delay before the nth consecutive reconnect (0-based): exponential from RECONNECT_BASE_MS to a
 * RECONNECT_MAX_MS ceiling, so a persistent failure (a retired client version, an outage) re-dials
 * at a sane rate instead of hammering WhatsApp every couple of seconds for days.
 */
export function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
}

export type WhatsAppStatus = "connected" | "connecting" | "loggedOut" | "qr";

export interface WhatsAppState {
  qr: string | undefined;
  status: WhatsAppStatus;
  user: string | undefined;
}

export interface InboundMessage {
  audio: { data: Buffer; mimeType: string; seconds: number | undefined } | undefined;
  from: string;
  images: ImageContent[];
  key: WAMessage["key"];
  number: string;
  quoted: QuotedContext | undefined;
  text: string;
}

export interface WhatsApp {
  getState: () => WhatsAppState;
  presence: (to: string, state: "available" | "composing" | "paused") => Promise<void>;
  read: (key: WAMessage["key"]) => Promise<void>;
  relink: () => void;
  send: (to: string, text: string) => Promise<void>;
  setProfilePicture: (image: Buffer) => Promise<void>;
  stop: () => Promise<void>;
}

export interface WhatsAppOptions {
  baileysLogLevel: string;
  logger: Logger;
  maxChars: number;
  onConnect?: () => void;
  onMessage: (message: InboundMessage) => Promise<void> | void;
  whatsappDir: string;
}

/** Unwrap the common Baileys envelope messages down to the real content. */
function unwrap(content: Content): Content {
  return (
    content.ephemeralMessage?.message ??
    content.viewOnceMessage?.message ??
    content.viewOnceMessageV2?.message ??
    content.documentWithCaptionMessage?.message ??
    content
  );
}

/** Download an inbound media attachment to a buffer, logging and swallowing a failure. */
async function downloadMedia(
  sock: Socket,
  message: WAMessage,
  logger: Logger,
  kind: "audio" | "image",
): Promise<Buffer | undefined> {
  try {
    return await downloadMediaMessage(
      message,
      "buffer",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
  } catch (error) {
    logger.error({ error }, `failed to download ${kind}`);
    return undefined;
  }
}

/**
 * Build the quoted-reply context from a message's contextInfo: classify the quoted
 * message, work out who sent it (Apollo, the user, or unknown), and download its image
 * or voice bytes so the agent can see/hear it. Media download is best-effort - a failure
 * just leaves the media out, and the [context] line degrades to a plain label.
 */
async function toQuoted(
  sock: Socket,
  message: WAMessage,
  contextInfo: QuotedInfo,
  userNumber: string,
  logger: Logger,
): Promise<QuotedContext> {
  const quotedMessage = contextInfo.quotedMessage!;
  const { kind, text } = describeQuotedMessage(quotedMessage);
  const self = sock.user?.id ? numberFromJid(sock.user.id) : "";
  const author = numberFromJid(contextInfo.participant ?? "");
  const sender: QuotedContext["sender"] =
    author && author === self ? "apollo" : author && author === userNumber ? "user" : "unknown";

  const images: ImageContent[] = [];
  let audio: QuotedContext["audio"];
  if (kind === "image" || kind === "voice") {
    const quotedWA = {
      key: {
        fromMe: sender === "apollo",
        id: contextInfo.stanzaId ?? undefined,
        participant: contextInfo.participant ?? undefined,
        remoteJid: message.key.remoteJid,
      },
      message: quotedMessage,
    } as WAMessage;
    const buffer = await downloadMedia(
      sock,
      quotedWA,
      logger,
      kind === "image" ? "image" : "audio",
    );
    if (buffer && kind === "image") {
      images.push({
        data: buffer.toString("base64"),
        mimeType: quotedMessage.imageMessage?.mimetype ?? "image/jpeg",
        type: "image",
      });
    } else if (buffer) {
      audio = { data: buffer, mimeType: quotedMessage.audioMessage?.mimetype ?? "audio/ogg" };
    }
  }
  return { audio, images, kind, sender, text };
}

async function toInbound(
  sock: Socket,
  message: WAMessage,
  logger: Logger,
): Promise<InboundMessage | undefined> {
  const remote = message.key.remoteJid;
  if (!remote || message.key.fromMe || !message.message) return undefined;
  // Individual chats only (skip groups, status broadcast, newsletters).
  if (isJidGroup(remote) || remote.endsWith("@broadcast") || remote.endsWith("@newsletter")) {
    return undefined;
  }

  // remoteJid may be a LID (@lid) or a phone JID (@s.whatsapp.net); the phone
  // number used for the allowlist lives on remoteJidAlt when addressed by LID.
  const phoneJid = isLidUser(remote) ? (message.key.remoteJidAlt ?? remote) : remote;
  const from = jidNormalizedUser(phoneJid);
  const number = numberFromJid(from);

  const content = unwrap(message.message);
  const image = content.imageMessage;
  const images: ImageContent[] = [];
  if (image) {
    const buffer = await downloadMedia(sock, message, logger, "image");
    if (buffer) {
      images.push({
        data: buffer.toString("base64"),
        mimeType: image.mimetype ?? "image/jpeg",
        type: "image",
      });
    }
  }

  const audioMessage = content.audioMessage;
  let audio: InboundMessage["audio"];
  if (audioMessage) {
    const buffer = await downloadMedia(sock, message, logger, "audio");
    if (buffer) {
      audio = {
        data: buffer,
        mimeType: audioMessage.mimetype ?? "audio/ogg",
        seconds: audioMessage.seconds ?? undefined,
      };
    }
  }

  const text = (
    content.conversation ??
    content.extendedTextMessage?.text ??
    image?.caption ??
    ""
  ).trim();

  const contextInfo =
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.audioMessage?.contextInfo ??
    content.documentMessage?.contextInfo ??
    content.stickerMessage?.contextInfo ??
    undefined;
  const quoted = contextInfo?.quotedMessage
    ? await toQuoted(sock, message, contextInfo, number, logger)
    : undefined;

  if (!text && images.length === 0 && !audio && !quoted) return undefined;
  return { audio, from, images, key: message.key, number, quoted, text };
}

/** Connect to WhatsApp via Baileys, tracking link state and dispatching inbound messages. */
export async function startWhatsApp(options: WhatsAppOptions): Promise<WhatsApp> {
  let session = await useMultiFileAuthState(options.whatsappDir);
  let sessionReset: Promise<void> | undefined;
  let version: { at: number; value: WAVersion } | undefined;
  let attempts = 0;
  let sock: Socket | undefined;
  let status: WhatsAppStatus = "connecting";
  let qr: string | undefined;
  let user: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  /** Drop the stored session, so the next connection pairs from scratch and issues a QR. */
  async function resetSession(): Promise<void> {
    await rm(options.whatsappDir, { force: true, recursive: true });
    session = await useMultiFileAuthState(options.whatsappDir);
  }

  /**
   * The WhatsApp Web client version to announce. Baileys hardcodes one, and WhatsApp eventually
   * retires it - from then on the server terminates every login, silently and forever - so the live
   * version is looked up instead (web.whatsapp.com, then the Baileys release feed). Both helpers
   * fall back to the bundled version rather than throwing, and report that as `isLatest: false`;
   * only a real answer is cached, so a failed lookup is retried on the next attempt.
   */
  async function waVersion(): Promise<WAVersion> {
    if (version && Date.now() - version.at < VERSION_TTL_MS) return version.value;
    const web = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(VERSION_TIMEOUT_MS) });
    const resolved = web.isLatest ? web : await fetchLatestBaileysVersion();
    if (resolved.isLatest) {
      version = { at: Date.now(), value: resolved.version };
      options.logger.info({ version: resolved.version.join(".") }, "whatsapp web version resolved");
    } else {
      options.logger.warn(
        { version: resolved.version.join(".") },
        "could not resolve the current whatsapp web version; falling back to the bundled one",
      );
    }
    return resolved.version;
  }

  function scheduleReconnect(delayMs: number): void {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connect();
    }, delayMs);
  }

  async function connect(): Promise<void> {
    await sessionReset; // never dial while the stored session is being replaced
    const { saveCreds, state } = session;
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Apollo"),
      // Baileys chatter is pure WhatsApp-transport noise, so it's silenced by default
      // (baileysLogLevel). When raised for debugging, its records are tagged src:baileys so they
      // still never forward to WhatsApp (see shouldNotify).
      logger: options.logger.child({ src: "baileys" }, { level: options.baileysLogLevel }),
      version: await waVersion(),
    });
    sock = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr: nextQr } = update;
      if (nextQr) {
        qr = nextQr;
        status = "qr";
      }
      if (connection === "open") {
        attempts = 0;
        qr = undefined;
        status = "connected";
        user = socket.user?.id;
        options.logger.info("whatsapp connected");
        void socket.sendPresenceUpdate("available");
        options.onConnect?.();
      }
      if (connection === "close") {
        const error = lastDisconnect?.error as
          | { message?: string; output?: { statusCode?: number } }
          | undefined;
        const code = error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          options.logger.warn("whatsapp logged out; clearing creds and re-issuing a QR");
          attempts = 0;
          status = "loggedOut";
          qr = undefined;
          user = undefined;
          sessionReset = resetSession();
          scheduleReconnect(1000);
          return;
        }
        status = "connecting";
        const delayMs = reconnectDelay(attempts);
        attempts += 1;
        // A single blip is routine, so it stays at info; only a run of them is worth a warning. The
        // message is constant either way, so the WhatsApp notifier's throttle collapses a storm of
        // them into one line and the detail lives in the fields.
        const detail = { attempt: attempts, code, delayMs, reason: error?.message };
        const level = attempts >= WARN_AFTER_ATTEMPTS ? "warn" : "info";
        options.logger[level](detail, "whatsapp disconnected; reconnecting");
        scheduleReconnect(delayMs);
      }
    });

    socket.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        options.logger.info(
          {
            fromMe: message.key.fromMe,
            remoteJid: message.key.remoteJid,
            remoteJidAlt: message.key.remoteJidAlt,
          },
          "inbound message",
        );
        const inbound = await toInbound(socket, message, options.logger);
        if (inbound) await options.onMessage(inbound);
      }
    });
  }

  void connect();

  return {
    getState: () => ({ qr, status, user: user ? numberFromJid(user) : undefined }),
    presence: async (to, state) => {
      try {
        await sock?.sendPresenceUpdate(state, to);
      } catch {
        // presence is best-effort
      }
    },
    read: async (key) => {
      try {
        await sock?.readMessages([key]);
      } catch {
        // read receipt is best-effort
      }
    },
    relink: () => {
      attempts = 0;
      qr = undefined;
      status = "connecting";
      user = undefined;
      sock?.end(undefined);
      // Relinking means pairing a new device, so the stored session goes: while creds are on disk
      // Baileys logs in instead of pairing and no QR is ever issued.
      sessionReset = resetSession();
      scheduleReconnect(500);
    },
    send: async (to, text) => {
      for (const chunk of splitMessage(text, options.maxChars)) {
        await sock?.sendMessage(to, { text: chunk });
      }
    },
    setProfilePicture: async (image) => {
      const jid = sock?.user?.id;
      if (!sock || !jid) throw new Error("whatsapp not connected");
      await sock.query({
        tag: "iq",
        attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
        content: [{ tag: "picture", attrs: { type: "image" }, content: image }],
      });
    },
    stop: async () => {
      sock?.end(undefined);
    },
  };
}
