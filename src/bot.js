import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import { config } from './config.js';
import { convertToSticker } from './stickerConverter.js';

const execFileAsync = promisify(execFile);
const logger = pino({ level: 'warn' });
const groupSubjectCache = new Map();
const pendingLinks = new Map();

let ultimoQR = null;
let estadoConexion = 'Iniciando bot...';

// ==========================================
// 1. SERVIDOR WEB PARA EL QR DE WHATSAPP
// ==========================================
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
  console.log(`[MediaBot] Servidor web listo en puerto ${PORT}`);
});

// ==========================================
// 2. MOTOR DE DESCARGA (TIKTOK + YT-DLP)
// ==========================================
const SUPPORTED_URL_REGEX =
  /https?:\/\/(?:www\.|m\.|vm\.|vt\.)?(?:x\.com|twitter\.com|instagram\.com|tiktok\.com|youtube\.com|youtu\.be)\/[^\s]+/i;

function extractSupportedUrl(text) {
  const match = text.match(SUPPORTED_URL_REGEX);
  return match ? match[0] : null;
}

async function downloadFromTikTok(url, mode) {
  const apiRes = await fetch(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
  );
  const json = await apiRes.json();
  if (json.code !== 0 || !json.data) {
    throw new Error(json.msg || 'No se pudo obtener el enlace de TikTok');
  }

  const targetUrl = mode === 'audio' ? json.data.music : json.data.play;
  if (!targetUrl) {
    throw new Error('TikTok no devolvió archivo descargable');
  }

  const fileRes = await fetch(targetUrl);
  if (!fileRes.ok) {
    throw new Error(`Error descargando archivo de TikTok (${fileRes.status})`);
  }

  const arrayBuffer = await fileRes.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return {
    buffer,
    ext: mode === 'audio' ? 'mp3' : 'mp4',
    isVideo: mode !== 'audio',
  };
}

async function downloadMediaFromUrl(url, mode) {
  // Si es TikTok, usar extractor directo sin marca de agua
  if (/tiktok\.com/i.test(url)) {
    return await downloadFromTikTok(url, mode);
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (mode === 'audio') {
    const outTemplate = path.join(os.tmpdir(), `wsb-aud-${id}.%(ext)s`);
    const finalPath = path.join(os.tmpdir(), `wsb-aud-${id}.mp3`);
    try {
      await execFileAsync(config.ytdlpPath, [
        '--no-playlist',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '-o',
        outTemplate,
        url,
      ]);
      const buffer = await fs.promises.readFile(finalPath);
      return { buffer, ext: 'mp3', isVideo: false };
    } finally {
      await fs.promises.unlink(finalPath).catch(() => {});
    }
  }

  const tempPath = path.join(os.tmpdir(), `wsb-vid-${id}.mp4`);
  try {
    await execFileAsync(config.ytdlpPath, [
      '--no-playlist',
      '-f',
      'bv*[ext=mp4][vcodec^=avc1][filesize<45M]+ba[ext=m4a]/b[ext=mp4][filesize<45M]/b[ext=mp4]/b',
      '--merge-output-format',
      'mp4',
      '-o',
      tempPath,
      url,
    ]);
    const buffer = await fs.promises.readFile(tempPath);
    return { buffer, ext: 'mp4', isVideo: true };
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
}

// ==========================================
// 3. LÓGICA DE WHATSAPP
// ==========================================
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
  if (groupSubjectCache.has(jid)) return groupSubjectCache.get(jid);
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
  } catch {}
}

function detectDirectMedia(content) {
  if (content.imageMessage) return { isAnimated: false, ext: 'jpg' };
  if (content.videoMessage) return { isAnimated: true, ext: 'mp4' };
  if (content.documentMessage) {
    const mime = content.documentMessage.mimetype || '';
    if (mime.startsWith('image/')) {
      const isGif = mime === 'image/gif';
      return { isAnimated: isGif, ext: isGif ? 'gif' : 'png' };
    }
    if (mime.startsWith('video/')) return { isAnimated: true, ext: 'mp4' };
  }
  return null;
}

async function processWhatsAppUrlAction(sock, remoteJid, msg, url, action) {
  await react(sock, remoteJid, msg.key, '⏳');
  try {
    if (action === 'video') {
      const { buffer } = await downloadMediaFromUrl(url, 'video');
      await sock.sendMessage(remoteJid, { video: buffer }, { quoted: msg });
    } else if (action === 'audio') {
      const { buffer } = await downloadMediaFromUrl(url, 'audio');
      await sock.sendMessage(
        remoteJid,
        { audio: buffer, mimetype: 'audio/mpeg' },
        { quoted: msg },
      );
    } else if (action === 'sticker') {
      const { buffer, ext } = await downloadMediaFromUrl(url, 'sticker');
      const sticker = await convertToSticker(buffer, {
        isAnimated: true,
        ext,
        packName: config.packName,
        author: config.author,
        maxVideoSeconds: config.maxVideoSeconds,
      });
      await sock.sendMessage(remoteJid, { sticker }, { quoted: msg });
    }
    await react(sock, remoteJid, msg.key, '✅');
  } catch (err) {
    console.error('[WhatsApp] Error:', err);
    await react(sock, remoteJid, msg.key, '❌');
    await sock.sendMessage(
      remoteJid,
      { text: `Error al procesar: ${err.message}` },
      { quoted: msg },
    );
  }
}

async function handleWhatsAppMessage(sock, msg) {
  const remoteJid = msg.key?.remoteJid;
  if (!remoteJid || remoteJid === 'status@broadcast') return;

  const content = unwrapMessage(msg.message);
  if (!content) return;

  if (
    msg.key.fromMe &&
    (content.stickerMessage || content.videoMessage || content.audioMessage)
  ) {
    return;
  }

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

  // 1. Respuesta al menú interactivo (1, 2 o 3)
  if (/^[123]$/.test(text) && pendingLinks.has(remoteJid)) {
    const saved = pendingLinks.get(remoteJid);
    pendingLinks.delete(remoteJid);
    const map = { '1': 'video', '2': 'audio', '3': 'sticker' };
    await processWhatsAppUrlAction(sock, remoteJid, msg, saved.url, map[text]);
    return;
  }

  // 2. Atajos directos (!video, !audio, !sticker)
  const url = extractSupportedUrl(text);
  if (url) {
    if (/^!video\b/i.test(text)) {
      await processWhatsAppUrlAction(sock, remoteJid, msg, url, 'video');
      return;
    }
    if (/^!audio\b/i.test(text)) {
      await processWhatsAppUrlAction(sock, remoteJid, msg, url, 'audio');
      return;
    }
    if (/^!sticker\b/i.test(text)) {
      await processWhatsAppUrlAction(sock, remoteJid, msg, url, 'sticker');
      return;
    }

    pendingLinks.set(remoteJid, { url, time: Date.now() });
    await sock.sendMessage(
      remoteJid,
      {
        text:
          '¿Qué quieres hacer con este enlace?\n\n' +
          '1️⃣ Descargar video (MP4)\n' +
          '2️⃣ Solo audio (MP3)\n' +
          '3️⃣ Hacer sticker\n\n' +
          'Responde con *1*, *2* o *3*',
      },
      { quoted: msg },
    );
    return;
  }

  // 3. Foto o video subido directo -> Convertir a sticker
  const directMedia = detectDirectMedia(content);
  if (directMedia) {
    await react(sock, remoteJid, msg.key, '⏳');
    try {
      const buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        { logger, reuploadRequest: sock.updateMediaMessage },
      );
      const sticker = await convertToSticker(buffer, {
        isAnimated: directMedia.isAnimated,
        ext: directMedia.ext,
        packName: config.packName,
        author: config.author,
        maxVideoSeconds: config.maxVideoSeconds,
      });
      await sock.sendMessage(remoteJid, { sticker }, { quoted: msg });
      await react(sock, remoteJid, msg.key, '✅');
    } catch (err) {
      await react(sock, remoteJid, msg.key, '❌');
      await sock.sendMessage(
        remoteJid,
        { text: `No pude convertir a sticker: ${err.message}` },
        { quoted: msg },
      );
    }
  }
}

// ==========================================
// 4. BOT DE TELEGRAM CON BOTONES REALES
// ==========================================
const telegramLinks = new Map();

async function tgApi(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSendFile(token, method, chatId, fieldName, buffer, filename) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(fieldName, new Blob([buffer]), filename);
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    body: form,
  });
  return res.json();
}

async function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[Telegram] Sin TELEGRAM_BOT_TOKEN, omitiendo Telegram.');
    return;
  }
  console.log('[Telegram] Bot de Telegram iniciado con menú interactivo.');

  let offset = 0;
  while (true) {
    try {
      const data = await tgApi(token, 'getUpdates', {
        offset,
        timeout: 25,
        allowed_updates: ['message', 'callback_query'],
      });

      if (!data.ok) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;

        if (update.message) {
          const chatId = update.message.chat.id;
          const text = update.message.text || '';
          const url = extractSupportedUrl(text);

          if (url) {
            const linkId = Math.random().toString(36).slice(2, 9);
            telegramLinks.set(linkId, url);

            await tgApi(
