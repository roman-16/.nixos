import { rm } from "node:fs/promises";

import type { ImageContent } from "@earendil-works/pi-ai";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  isJidGroup,
  isLidUser,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import { numberFromJid, splitMessage } from "./messages";

type Socket = ReturnType<typeof makeWASocket>;
type Content = NonNullable<WAMessage["message"]>;

export type WhatsAppStatus = "connected" | "connecting" | "loggedOut" | "qr";

export interface WhatsAppState {
  qr: string | undefined;
  status: WhatsAppStatus;
  user: string | undefined;
}

export interface InboundMessage {
  from: string;
  images: ImageContent[];
  key: WAMessage["key"];
  number: string;
  text: string;
}

export interface WhatsApp {
  getState: () => WhatsAppState;
  presence: (to: string, state: "available" | "composing" | "paused") => Promise<void>;
  read: (key: WAMessage["key"]) => Promise<void>;
  relink: () => void;
  send: (to: string, text: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface WhatsAppOptions {
  logger: Logger;
  maxChars: number;
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

  const content = unwrap(message.message);
  const image = content.imageMessage;
  const images: ImageContent[] = [];
  if (image) {
    try {
      const buffer = await downloadMediaMessage(
        message,
        "buffer",
        {},
        { logger, reuploadRequest: sock.updateMediaMessage },
      );
      images.push({
        data: buffer.toString("base64"),
        mimeType: image.mimetype ?? "image/jpeg",
        type: "image",
      });
    } catch (error) {
      logger.error({ error }, "failed to download image");
    }
  }

  const text = (
    content.conversation ??
    content.extendedTextMessage?.text ??
    image?.caption ??
    ""
  ).trim();
  if (!text && images.length === 0) return undefined;
  return { from, images, key: message.key, number: numberFromJid(from), text };
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
      logger: options.logger,
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
    stop: async () => {
      sock?.end(undefined);
    },
  };
}
