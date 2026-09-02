import { createWriteStream, statSync, unlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

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
  toNumber,
  useMultiFileAuthState,
  type WAMessage,
  type WAVersion,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import type { Attachment } from "./attachments";
import type { FileStore, ReceivedFile } from "./files";
import { humanBytes } from "./format";
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

/**
 * How much text rides along under a photo or a file. WhatsApp takes far less in a caption than in a
 * message, so anything longer follows as ordinary messages rather than being silently dropped.
 */
const MAX_CAPTION_CHARS = 900;

/** What a file claims to be when WhatsApp says nothing about it. */
const UNKNOWN_MIME = "application/octet-stream";

// A voice note is spoken into the microphone; an audio file is picked out of the phone's storage.
// WhatsApp marks the first with ptt and encodes it as opus in ogg, and either is enough - so a
// voice note is never filed away as an attachment for want of one flag.
const VOICE_MIME = /(ogg|opus)/i;

// Subtypes whose name is not the extension anyone uses.
const EXTENSION_FIX: Record<string, string> = {
  mpeg: "mp3",
  plain: "txt",
  quicktime: "mov",
  "x-matroska": "mkv",
};

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
  /** Since when there has been no link (the process start counts); undefined while connected. */
  downSince: number | undefined;
  qr: string | undefined;
  status: WhatsAppStatus;
  user: string | undefined;
}

export interface InboundMessage {
  audio: { data: Buffer; mimeType: string; seconds: number | undefined } | undefined;
  /** What came with it that is not for reading, already on disk (or refused, and saying why). */
  files: ReceivedFile[];
  from: string;
  images: ImageContent[];
  key: WAMessage["key"];
  number: string;
  /** Whether WhatsApp held this message in its offline queue rather than delivering it live. */
  offline: boolean;
  quoted: QuotedContext | undefined;
  /** When the user sent it, per WhatsApp's clock. */
  sentAt: number;
  text: string;
  /** WhatsApp's own message id - the identity the inbox deduplicates on. */
  waId: string;
}

export interface WhatsApp {
  getState: () => WhatsAppState;
  presence: (to: string, state: "available" | "composing" | "paused") => Promise<void>;
  read: (key: WAMessage["key"]) => Promise<void>;
  relink: () => void;
  send: (to: string, text: string) => Promise<void>;
  /** Put a picture or a file in front of the user, with an optional line under it. */
  sendMedia: (to: string, attachment: Attachment, caption: string) => Promise<void>;
  setProfilePicture: (image: Buffer) => Promise<void>;
  stop: () => Promise<void>;
}

export interface WhatsAppOptions {
  baileysLogLevel: string;
  /** Where a file that arrives is put, since it never rides in the conversation. */
  fileStore: FileStore;
  logger: Logger;
  maxChars: number;
  maxFileBytes: number;
  onConnect?: () => void;
  /** One delivery from WhatsApp, which may carry a whole queue's worth of messages at once. */
  onMessages: (messages: InboundMessage[]) => Promise<void> | void;
  /** Whether a message the phone's history carries is still worth downloading and answering. */
  wantsMessage: (waId: string, sentAt: number) => boolean;
  whatsappDir: string;
}

/** When the user sent it, per WhatsApp's second-resolution clock; unstamped means now. */
export function whenSent(message: Pick<WAMessage, "messageTimestamp">): number {
  const stamped = toNumber(message.messageTimestamp) * 1000;
  return stamped > 0 ? stamped : Date.now();
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

/** What receiving a message needs: the connection it came in on, and somewhere to put a file. */
interface Receiving {
  logger: Logger;
  maxFileBytes: number;
  sock: Socket;
  store: FileStore;
}

/** Download an inbound media attachment to a buffer, logging and swallowing a failure. */
async function downloadMedia(
  receiving: Receiving,
  message: WAMessage,
  kind: "audio" | "image",
): Promise<Buffer | undefined> {
  const { logger, sock } = receiving;
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
 * Whether an audio message is a voice note rather than an audio file the user picked out. The first
 * is words, and is transcribed; the second is a file, and goes to disk like any other.
 */
export function isVoiceNote(audio: NonNullable<Content["audioMessage"]>): boolean {
  return audio.ptt === true || VOICE_MIME.test(audio.mimetype ?? "");
}

/** A message's file, if it carries one: everything that is neither a picture nor a voice note. */
interface FileInfo {
  fileLength?: Parameters<typeof toNumber>[0];
  fileName?: null | string;
  mimetype?: null | string;
  /** What to call it when WhatsApp carries no name, as a video or an audio file never does. */
  stem: string;
}

function fileInfo(content: Content): FileInfo | undefined {
  const document = content.documentMessage;
  if (document) {
    return {
      fileLength: document.fileLength,
      fileName: document.fileName ?? document.title,
      mimetype: document.mimetype,
      stem: "document",
    };
  }
  const video = content.videoMessage;
  if (video) {
    return { fileLength: video.fileLength, mimetype: video.mimetype, stem: "video" };
  }
  const audio = content.audioMessage;
  if (audio && !isVoiceNote(audio)) {
    return { fileLength: audio.fileLength, mimetype: audio.mimetype, stem: "audio" };
  }
  return undefined;
}

/** The name to keep a file under: the one WhatsApp carried, or one built from what it is. */
export function mediaName(
  given: null | string | undefined,
  mimeType: string,
  stem: string,
): string {
  const named = given?.trim();
  if (named) return named;
  const subtype = mimeType.split("/")[1] || "bin";
  return `${stem}.${EXTENSION_FIX[subtype] ?? subtype}`;
}

function discard(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // never written, or already gone
  }
}

/**
 * Put a message's file on disk, or say why it is not there.
 *
 * It is streamed rather than read, so a file the size of the cap never sits in memory. One too
 * large is refused before it is fetched, and one that arrives larger than it claimed is deleted -
 * but either way the message still goes through carrying the refusal, because a file nobody
 * mentions is indistinguishable from a message nobody read.
 */
async function receiveFile(
  receiving: Receiving,
  message: WAMessage,
  info: FileInfo,
): Promise<ReceivedFile> {
  const { logger, maxFileBytes, sock, store } = receiving;
  const mimeType = (info.mimetype ?? "").split(";")[0]!.trim() || UNKNOWN_MIME;
  const name = mediaName(info.fileName, mimeType, info.stem);
  const claimed = toNumber(info.fileLength);
  const tooBig = (size: number) =>
    `it is ${humanBytes(size)}, and I stop at ${humanBytes(maxFileBytes)}`;
  if (claimed > maxFileBytes) return { mimeType, name, problem: tooBig(claimed), size: claimed };

  const path = store.slot(message.key.id!, name);
  try {
    const stream = await downloadMediaMessage(
      message,
      "stream",
      {},
      { logger, reuploadRequest: sock.updateMediaMessage },
    );
    await pipeline(stream, createWriteStream(path));
  } catch (error) {
    logger.error({ error }, "failed to download file");
    discard(path);
    return { mimeType, name, problem: "the download failed", size: claimed };
  }

  // What it claimed is not what it is, so the cap is enforced on what actually landed.
  const size = statSync(path).size;
  if (size > maxFileBytes) {
    discard(path);
    return { mimeType, name, problem: tooBig(size), size };
  }
  return { mimeType, name, path, size };
}

/**
 * Build the quoted-reply context from a message's contextInfo: classify the quoted
 * message, work out who sent it (Apollo, the user, or unknown), and download its image
 * or voice bytes so the agent can see/hear it. Media download is best-effort - a failure
 * just leaves the media out, and the [context] line degrades to a plain label.
 */
async function toQuoted(
  receiving: Receiving,
  message: WAMessage,
  contextInfo: QuotedInfo,
  userNumber: string,
): Promise<QuotedContext> {
  const { sock } = receiving;
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
    const buffer = await downloadMedia(receiving, quotedWA, kind === "image" ? "image" : "audio");
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
  receiving: Receiving,
  message: WAMessage,
  offline: boolean,
): Promise<InboundMessage | undefined> {
  const remote = message.key.remoteJid;
  if (!remote || message.key.fromMe || !message.message || !message.key.id) return undefined;
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

  // Everything WhatsApp delivers is either something Apollo can read - a picture it looks at, a
  // voice note it transcribes - or an object, which goes to disk and is handed over as a path. A
  // sticker is a picture; an audio file nobody spoke into is an object, as documents and videos are.
  const picture = content.imageMessage ?? content.stickerMessage;
  const images: ImageContent[] = [];
  if (picture) {
    const buffer = await downloadMedia(receiving, message, "image");
    if (buffer) {
      images.push({
        data: buffer.toString("base64"),
        mimeType: picture.mimetype ?? "image/jpeg",
        type: "image",
      });
    }
  }

  const audioMessage = content.audioMessage;
  let audio: InboundMessage["audio"];
  if (audioMessage && isVoiceNote(audioMessage)) {
    const buffer = await downloadMedia(receiving, message, "audio");
    if (buffer) {
      audio = {
        data: buffer,
        mimeType: audioMessage.mimetype ?? "audio/ogg",
        seconds: audioMessage.seconds ?? undefined,
      };
    }
  }

  const wanted = fileInfo(content);
  const files = wanted ? [await receiveFile(receiving, message, wanted)] : [];

  const text = (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
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
    ? await toQuoted(receiving, message, contextInfo, number)
    : undefined;

  if (!text && images.length === 0 && !audio && !quoted && files.length === 0) return undefined;
  return {
    audio,
    files,
    from,
    images,
    key: message.key,
    number,
    offline,
    quoted,
    sentAt: whenSent(message),
    text,
    waId: message.key.id,
  };
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
  let downSince: number | undefined = Date.now();
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
    const receiving: Receiving = {
      logger: options.logger,
      maxFileBytes: options.maxFileBytes,
      sock: socket,
      store: options.fileStore,
    };

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
        downSince = undefined;
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
        downSince ??= Date.now();
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
      // "append" is what WhatsApp's offline queue and history syncs arrive as - the transport type
      // must never decide whether a message is real, or an outage silently eats every message sent
      // during it. What does not belong (our own sends, groups, newsletters, strangers) is filtered
      // by toInbound and the allowlist, and the inbox settles duplicates by message id.
      const offline = type !== "notify";
      // The queue WhatsApp held during an outage arrives as one event, so it is passed on as one
      // batch: that is what lets it be answered as a single catch-up rather than message by message.
      const inbound: InboundMessage[] = [];
      for (const message of messages) {
        const one = await toInbound(receiving, message, offline);
        if (one) inbound.push(one);
      }
      options.logger.info(
        { accepted: inbound.length, offline, received: messages.length },
        "inbound delivery",
      );
      if (inbound.length > 0) await options.onMessages(inbound);
    });

    // Pairing is not reconnecting: a freshly linked device has its own keys, so WhatsApp replays no
    // queue to it - the phone pushes its recent history instead, and everything written while the
    // link was down is in there or nowhere. Sifting by what the inbox still wants is what keeps the
    // history that was already answered from being downloaded, let alone answered twice.
    socket.ev.on("messaging-history.set", async ({ messages }) => {
      const inbound: InboundMessage[] = [];
      for (const message of messages) {
        const waId = message.key.id;
        if (!waId || !options.wantsMessage(waId, whenSent(message))) continue;
        const one = await toInbound(receiving, message, true);
        if (one) inbound.push(one);
      }
      options.logger.info({ accepted: inbound.length, received: messages.length }, "history sync");
      if (inbound.length > 0) await options.onMessages(inbound);
    });
  }

  void connect();

  return {
    getState: () => ({ downSince, qr, status, user: user ? numberFromJid(user) : undefined }),
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
      downSince ??= Date.now();
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
    sendMedia: async (to, attachment, caption) => {
      const [head, ...rest] = splitMessage(caption, MAX_CAPTION_CHARS);
      // A picture carries its dimensions and preview, so baileys never reaches for the image library
      // it does not have here; a file is named by its path, so its bytes are streamed off disk
      // rather than read into memory (see attachments.ts).
      await sock?.sendMessage(
        to,
        attachment.kind === "image"
          ? {
              caption: head,
              height: attachment.height,
              image: attachment.bytes,
              jpegThumbnail: attachment.thumbnail,
              mimetype: attachment.mimeType,
              width: attachment.width,
            }
          : {
              caption: head,
              document: { url: attachment.path },
              fileName: attachment.name,
              mimetype: attachment.mimeType,
            },
      );
      for (const chunk of rest) await sock?.sendMessage(to, { text: chunk });
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
