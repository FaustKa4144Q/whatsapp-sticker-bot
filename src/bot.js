import http from 'node:http';
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

const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();

let ultimoQR = null;
let estadoConexion = 'Iniciando bot...';

// Mini servidor web para mostrar el QR limpio
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (estadoConexion === 'Conectado') {
    res.end(`
      <html>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#4ade80;text-align:center;">
          <h1>✅ ¡Bot conectado a WhatsApp correctamente!<br><span style="font-size:18px;color:#ccc;">Ya puedes cerrar esta página.</span></h1>
        </body>
      </html>
    `);
    return;
  }

  if (!ultimoQR) {
    res.end(`
      <html>
        <head><meta http-equiv="refresh" content="3"></head>
        <body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#111;color:#fff;">
          <h2>⏳ Generando código QR, espera un momento...</h2>
        </body>
      </html>
    `);
    return;
  }

  res.end(`
    <html>
      <head>
        <meta http-equiv="refresh" content="15">
        <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
      </head>
      <body style="display:flex;flex-direction:column;justify-content:center;align-items:center;height:100vh;margin:0;font-family:sans-serif;background:#ffffff;color:#111;">
        <h2 style="margin-bottom:20px;">Escanea este QR con WhatsApp</h2>
        <div id="qrcode" style="padding:20px;background:#fff;border:4px solid #111;border-radius:12px;"></div>
        <p style="margin-top:15px;color:#555;">La página se actualiza sola cada 15 segundos</p>
        <script>
          new QRCode(document.getElementById("qrcode"), {
            text: ${JSON.stringify(ultimoQR)},
            width: 320,
            height: 320,
            correctLevel: QRCode.CorrectLevel.L
          });
        </script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[StickerBot] Servidor web del QR listo en puerto ${PORT}`);
});

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      ultimoQR = qr;
      estadoConexion = 'Esperando QR';
      console.log('[StickerBot] Nuevo QR generado en la página web.');
    }
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      estadoConexion = 'Reconectando...';
      console.warn(
        `[StickerBot] Conexión cerrada (code=${statusCode}). Reconectar: ${shouldReconnect}`,
      );
      if (shouldReconnect) {
        setTimeout(() => startBot(), 3000);
      }
    } else if (connection === 'open') {
      ultimoQR = null;
      estadoConexion = 'Conectado';
      console.log('[StickerBot] Conectado a WhatsApp correctamente.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });
}
