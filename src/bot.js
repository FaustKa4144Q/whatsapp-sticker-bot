import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from './config.js';
import { convertToSticker } from './stickerConverter.js';
import { extractXStatusUrl, fetchMediaFromX } from './xExtractor.js';

// 👇 PON AQUÍ TU NÚMERO CON CÓDIGO DE PAÍS (sin el signo + ni espacios)
const NUMERO_TELEFONO = '5212215142970';

const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();

function unwrapMessage(message) {
  let current = message;
  while (current) {
    if (current.ephemeralMessage?.message) {
      current = current.ephemeralMessage.message;
    } else if (current.viewOnceMessage?.message) {
      current = current.viewOnceMessage.message;
    } else if (current.viewOnceMessageV2?.message) {
      current = current.viewOnceMessageV2.message;
    } else {
      break;
    }
  }
  return current;
}

function extractText(content) {
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  ).trim();
}

async function getGroupSubject(sock, jid) {
  if (groupSubjectCache.has(jid)) {
    return groupSubjectCache.get(jid);
  }
  try {
    const meta = await sock.groupMetadata(jid);
    const subject = meta?.subject || '';
    groupSubjectCache.set(jid, subject);
    return subject;
  } catch {
    return '';
  }
}

async function isAuthorizedChat(sock, remoteJid) {
  if (!remoteJid || remoteJid === 'status@broadcast') return false;

  if (remoteJid.endsWith('@g.us')) {
    if (config.allowedGroupJids.includes(remoteJid)) return true;
    if (config.allowedGroupNames.length > 0) {
      const subject = await getGroupSubject(sock, remoteJid);
      return config.allowedGroupNames.includes(subject);
    }
    return false;
  }

  return config.allowedUserJids.includes(remoteJid);
}

async function react(sock, jid, key, emoji) {
  try {
    await sock.sendMessage(jid, { react: { text: emoji, key } });
  } catch {
    // Reactions are non-critical
  }
}

async function handleMessage(sock, msg) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const content = unwrapMessage(msg.message);
  if (!content) return;

  if (msg.key.fromMe && content.stickerMessage) return;

  const text = extractText(content);

  if (text === '!id' && remoteJid.endsWith('@g.us')) {
    const subject = await getGroupSubject(sock, remoteJid);
    await sock.sendMessage(
      remoteJid,
      { text: `JID del grupo "${subject}":\n${remoteJid}` },
      { quoted: msg },
    );
    return;
  }

    const authorized = msg.key.fromMe || (await isAuthorizedChat(sock, remoteJid));
  if (!authorized) return;


  const mediaSpec = detectMediaInput(content, text);
  if (!mediaSpec) return;

  await react(sock, remoteJid, msg.key, '⏳');

  try {
    if (mediaSpec.type === 'x-url') {
      const items = await fetchMediaFromX(mediaSpec.text, {
        ytdlpPath: config.ytdlpPath,
      });
      for (const item of items) {
        const sticker = await convertToSticker(item.buffer, {
          isAnimated: item.kind === 'video',
          ext: item.ext,
          packName: config.packName,
          author: config.author,
          maxVideoSeconds: config.maxVideoSeconds,
        });
        await sock.sendMessage(remoteJid, { sticker }, { quoted: msg });
      }
    } else {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger, reuploadRequest: sock.updateMediaMessage },
      );
      const sticker = await convertToSticker(buffer, {
        isAnimated: mediaSpec.isAnimated,
        ext: mediaSpec.ext,
        packName: config.packName,
        author: config.author,
        maxVideoSeconds: config.maxVideoSeconds,
      });
      await sock.sendMessage(remoteJid, { sticker }, { quoted: msg });
    }

    await react(sock, remoteJid, msg.key, '✅');
  } catch (err) {
    console.error('[StickerBot] Error procesando mensaje:', err);
    await react(sock, remoteJid, msg.key, '❌');
    await sock.sendMessage(
      remoteJid,
      { text: `No pude convertir eso a sticker: ${err.message}` },
      { quoted: msg },
    );
  }
}

function detectMediaInput(content, text) {
  if (content.imageMessage) {
    return { type: 'media', isAnimated: false, ext: 'jpg' };
  }
  if (content.videoMessage) {
    return { type: 'media', isAnimated: true, ext: 'mp4' };
  }
  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || '';
    if (mime.startsWith('image/')) {
      const isGif = mime === 'image/gif';
      return { type: 'media', isAnimated: isGif, ext: isGif ? 'gif' : 'png' };
    }
    if (mime.startsWith('video/')) {
      return { type: 'media', isAnimated: true, ext: 'mp4' };
    }
  }
  if (extractXStatusUrl(text)) {
    return { type: 'x-url', text };
  }
  return null;
}

export async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
  });

  let codigoSolicitado = false;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !codigoSolicitado && !sock.authState.creds.registered) {
      codigoSolicitado = true;
      try {
        const code = await sock.requestPairingCode(NUMERO_TELEFONO);
        console.log('\n========================================');
        console.log(`TU CÓDIGO DE VINCULACIÓN ES: ${code}`);
        console.log('========================================\n');
      } catch (err) {
        console.error('[StickerBot] Error al pedir el código:', err);
        codigoSolicitado = false;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.warn(
        `[StickerBot] Conexión cerrada (code=${statusCode}). Reconectar: ${shouldReconnect}`,
      );
      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    } else if (connection === 'open') {
      console.log('[StickerBot] Conectado a WhatsApp correctamente.');
      if (
        config.allowedGroupJids.length === 0 &&
        config.allowedGroupNames.length === 0
      ) {
        console.log(
          '[StickerBot] Sin grupos configurados aún. Envía "!id" en tu grupo para obtener su JID.',
        );
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });
}
