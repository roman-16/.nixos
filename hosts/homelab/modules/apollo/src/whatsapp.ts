import type { ImageContent } from "@earendil-works/pi-ai";
import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import type { Logger } from "pino";

import { numberFromJid, splitMessage } from "./messages.ts";

type Socket = ReturnType<typeof makeWASocket>;
type Content = NonNullable<WAMessage["message"]>;

export interface InboundMessage {
  from: string;
  images: ImageContent[];
  number: string;
  text: string;
}

export interface WhatsApp {
  send: (to: string, text: string) => Promise<void>;
  stop: () => Promise<void>;
}

export interface WhatsAppOptions {
  logger: Logger;
  maxChars: number;
  onMessage: (message: InboundMessage) => Promise<void> | void;
  pairingNumber: string | undefined;
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

  const from = jidNormalizedUser(remote);
  if (!from.endsWith("@s.whatsapp.net")) return undefined; // individual chats only

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
  return { from, images, number: numberFromJid(from), text };
}

async function requestPairing(sock: Socket, number: string, logger: Logger): Promise<void> {
  try {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const code = await sock.requestPairingCode(number);
    logger.warn(
      `WhatsApp pairing code for +${number}: ${code} (enter it in WhatsApp > Linked devices > Link with phone number)`,
    );
  } catch (error) {
    logger.error({ error }, "failed to request pairing code");
  }
}

/** Connect to WhatsApp via Baileys, persisting creds and dispatching inbound messages. */
export async function startWhatsApp(options: WhatsAppOptions): Promise<WhatsApp> {
  const { saveCreds, state } = await useMultiFileAuthState(options.whatsappDir);
  let pairingRequested = false;

  function connect(): Socket {
    const sock = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Apollo"),
      logger: options.logger,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !sock.authState.creds.registered && options.pairingNumber && !pairingRequested) {
        pairingRequested = true;
        void requestPairing(sock, options.pairingNumber, options.logger);
      }
      if (connection === "open") options.logger.info("whatsapp connected");
      if (connection === "close") {
        const status = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)
          ?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          options.logger.error("whatsapp logged out; clear the creds dir and re-pair");
        } else {
          options.logger.warn({ status }, "whatsapp connection closed, reconnecting");
          current = connect();
        }
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const message of messages) {
        const inbound = await toInbound(sock, message, options.logger);
        if (inbound) await options.onMessage(inbound);
      }
    });

    return sock;
  }

  let current = connect();

  return {
    send: async (to, text) => {
      for (const chunk of splitMessage(text, options.maxChars)) {
        await current.sendMessage(to, { text: chunk });
      }
    },
    stop: async () => {
      current.end(undefined);
    },
  };
}
