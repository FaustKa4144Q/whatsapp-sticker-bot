import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  generateMessageIDV2,
  prepareWAMessageMedia,
  proto,
} from '@whiskeysockets/baileys';

const execFileAsync = promisify(execFile);
const RAW_AUDIO_SYM = Symbol('rawAudioMsgBytes');
let encoderHooked = false;

function ensureStickerAudioEncoder() {
  if (encoderHooked) return;
  encoderHooked = true;

  const origEncode = proto.Message.StickerMessage.encode.bind(
    proto.Message.StickerMessage,
  );
  proto.Message.StickerMessage.encode = (message, writer) => {
    const w = origEncode(message, writer);
    if (message && message[RAW_AUDIO_SYM]) {
      // Campo 26 (wire type 2 => (26 << 3) | 2 = 210) para audioMessage dentro de StickerMessage
      w.uint32(210).bytes(message[RAW_AUDIO_SYM]);
    }
    return w;
  };
}

export async function extractOpusAudioFromVideo(videoBuffer, ext = 'mp4', maxSeconds = 5) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const inPath = path.join(os.tmpdir(), `aud-in-${id}.${ext}`);
  const outPath = path.join(os.tmpdir(), `aud-out-${id}.ogg`);

  try {
    await fs.promises.writeFile(inPath, videoBuffer);

    // Revisar si el video realmente tiene pista de audio (ej. los GIF de X no traen)
    const { stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'a',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      inPath,
    ]);
    if (!stdout.trim()) return null;

    await execFileAsync('ffmpeg', [
      '-y',
      '-i',
      inPath,
      '-t',
      String(Math.min(maxSeconds, 5)),
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      '-ar',
      '48000',
      '-ac',
      '1',
      outPath,
    ]);

    const oggBuffer = await fs.promises.readFile(outPath);
    return oggBuffer.length > 0 ? oggBuffer : null;
  } catch {
    return null;
  } finally {
    await fs.promises.unlink(inPath).catch(() => {});
    await fs.promises.unlink(outPath).catch(() => {});
  }
}

export async function sendSoundSticker(sock, jid, stickerBuffer, oggBuffer, quotedMsg) {
  ensureStickerAudioEncoder();

  const [preparedSticker, preparedAudio] = await Promise.all([
    prepareWAMessageMedia(
      { sticker: stickerBuffer },
      { upload: sock.waUploadToServer },
    ),
    prepareWAMessageMedia(
      { audio: oggBuffer, mimetype: 'audio/ogg; codecs=opus' },
      { upload: sock.waUploadToServer },
    ),
  ]);

  const stickerMsg = preparedSticker.stickerMessage;
  stickerMsg[RAW_AUDIO_SYM] = proto.Message.AudioMessage.encode(
    preparedAudio.audioMessage,
  ).finish();

  const message = { stickerMessage: stickerMsg };
  if (quotedMsg) {
    message.stickerMessage.contextInfo = {
      stanzaId: quotedMsg.key.id,
      participant: quotedMsg.key.participant || quotedMsg.key.remoteJid,
      quotedMessage: quotedMsg.message,
    };
  }

  const msgId = generateMessageIDV2(sock.user?.id);
  await sock.relayMessage(jid, message, { messageId: msgId });
  return { key: { remoteJid: jid, fromMe: true, id: msgId }, message };
}
