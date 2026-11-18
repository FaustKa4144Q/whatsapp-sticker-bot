import 'dotenv/config';

function parseCsvList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  // Aquí puedes cambiar el nombre del paquete y autor que saldrá en tus stickers:
  packName: process.env.STICKER_PACK_NAME || 'Mis Stickers',
  author: process.env.STICKER_AUTHOR || 'StickerBot',
    allowedGroupJids: ['120363433695915025@g.us'],
  allowedGroupNames: parseCsvList(process.env.ALLOWED_GROUP_NAMES),
  // 👇 PON TU NÚMERO AQUÍ (deja el @s.whatsapp.net al final):
  allowedUserJids: ['5212215142970@s.whatsapp.net'],
  maxVideoSeconds: Math.max(1, Number(process.env.MAX_VIDEO_SECONDS) || 8),
  ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
};
