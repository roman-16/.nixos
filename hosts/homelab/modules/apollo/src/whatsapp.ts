import { rm } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  S_WHATSAPP_NET,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import { numberFromJid, splitMessage } from "./messages";
import { describeQuotedMessage, type QuotedContext } from "./quoted";

type Socket = ReturnType<typeof makeWASocket>;
type Content = NonNullable<WAMessage["message"]>;
type QuotedInfo = NonNullable<NonNullable<Content["extendedTextMessage"]>["contextInfo"]>;

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
  let auth = await useMultiFileAuthState(options.whatsappDir);
  let sock: Socket | undefined;
  let status: WhatsAppStatus = "connecting";
  let qr: string | undefined;
  let user: string | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleReconnect(delayMs: number): void {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      sock = connect();
    }, delayMs);
  }

  function connect(): Socket {
    const socket = makeWASocket({
      auth: auth.state,
      browser: Browsers.ubuntu("Apollo"),
      // Baileys chatter is pure WhatsApp-transport noise, so it's silenced by default
      // (baileysLogLevel). When raised for debugging, its records are tagged src:baileys so they
      // still never forward to WhatsApp (see shouldNotify).
      logger: options.logger.child({ src: "baileys" }, { level: options.baileysLogLevel }),
    });

    socket.ev.on("creds.update", auth.saveCreds);

    socket.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr: nextQr } = update;
      if (nextQr) {
        qr = nextQr;
        status = "qr";
      }
      if (connection === "open") {
        qr = undefined;
        status = "connected";
        user = socket.user?.id;
        options.logger.info("whatsapp connected");
        void socket.sendPresenceUpdate("available");
        options.onConnect?.();
      }
      if (connection === "close") {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          options.logger.warn("whatsapp logged out; clearing creds and re-issuing a QR");
          status = "loggedOut";
          qr = undefined;
          user = undefined;
          await rm(options.whatsappDir, { force: true, recursive: true });
          auth = await useMultiFileAuthState(options.whatsappDir);
          scheduleReconnect(1000);
        } else {
          status = "connecting";
          scheduleReconnect(2000);
        }
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

    return socket;
  }

  sock = connect();

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
      qr = undefined;
      status = "connecting";
      sock?.end(undefined);
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
