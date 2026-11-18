import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

const JUNK_REGEX =
  /\b(karaoke|lullaby|tribute|ringtone|8-bit|music box|backing track|instrumental|piano version|cover)\b/i;

const YTDLP_YT_ARGS = [
  '--no-playlist',
  '--js-runtimes',
  'node',
  '--extractor-args',
  'youtube:player_client=tv_embedded,android_vr,ios',
];

function scoreRelevance(track, query) {
  const words = query
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const haystack = `${track.title} ${track.artist}`
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  let hits = 0;
  for (const w of words) {
    if (haystack.includes(w)) hits++;
  }
  return hits;
}

async function searchDeezer(query) {
  const res = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=15`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map((item) => ({
    title: (item.title || '').trim(),
    artist: (item.artist?.name || '').trim(),
    album: (item.album?.title || item.title || '').trim(),
    durationSec: Number(item.duration || 0),
    artworkUrl: item.album?.cover_xl || item.album?.cover_big || '',
  }));
}

async function searchItunes(query) {
  const res = await fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=15&country=MX`,
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((item) => ({
    title: (item.trackName || '').trim(),
    artist: (item.artistName || '').trim(),
    album: (item.collectionName || item.trackName || '').trim(),
    durationSec: Math.round((item.trackTimeMillis || 0) / 1000),
    artworkUrl: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
  }));
}

export async function searchTracks(query) {
  let rawResults = await searchDeezer(query).catch(() => []);
  if (rawResults.length === 0) {
    rawResults = await searchItunes(query).catch(() => []);
  }

  const userWantsCover = JUNK_REGEX.test(query);
  const seen = new Set();
  const clean = [];

  for (const item of rawResults) {
    if (!item.title || !item.artist) continue;
    if (!userWantsCover && (JUNK_REGEX.test(item.title) || JUNK_REGEX.test(item.artist))) {
      continue;
    }

    const key = `${item.title.toLowerCase()}|${item.artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    clean.push(item);
  }

  clean.sort((a, b) => scoreRelevance(b, query) - scoreRelevance(a, query));
  return clean.slice(0, 5);
}

function rankEntriesByDuration(entries, durationSec, fallbackPrefix) {
  if (!entries || entries.length === 0) return [];

  const valid = entries.filter((e) => !e.duration || e.duration >= 45);
  const list = valid.length > 0 ? valid : entries;

  if (durationSec > 0) {
    list.sort((a, b) => {
      const diffA = a.duration ? Math.abs(a.duration - durationSec) : 999;
      const diffB = b.duration ? Math.abs(b.duration - durationSec) : 999;
      return diffA - diffB;
    });
  }

  return list
    .map((e) => e.webpage_url || e.url || (e.id ? `${fallbackPrefix}${e.id}` : ''))
    .filter(Boolean);
}

async function searchAndDownloadAudio(track, rawOut) {
  const query = `${track.artist} - ${track.title}`;

  // 1. Intentar en YouTube probando los mejores candidatos por duración
  try {
    const { stdout } = await execFileAsync(config.ytdlpPath, [
      ...YTDLP_YT_ARGS,
      '--flat-playlist',
      '--dump-single-json',
      `ytsearch6:${query} audio`,
    ]);
    const ytUrls = rankEntriesByDuration(
      JSON.parse(stdout).entries || [],
      track.durationSec,
      'https://www.youtube.com/watch?v=',
    );

    for (const url of ytUrls.slice(0, 3)) {
      try {
        await execFileAsync(config.ytdlpPath, [
          ...YTDLP_YT_ARGS,
          '-x',
          '--audio-format',
          'mp3',
          '--audio-quality',
          '0',
          '-o',
          rawOut,
          url,
        ]);
        return;
      } catch {
        // Probar siguiente candidato o saltar a SoundCloud
      }
    }
  } catch {}

  // 2. Respaldo en SoundCloud saltando pistas protegidas con DRM
  const { stdout: scOut } = await execFileAsync(config.ytdlpPath, [
    '--no-playlist',
    '--flat-playlist',
    '--dump-single-json',
    `scsearch10:${query}`,
  ]);
  const scUrls = rankEntriesByDuration(
    JSON.parse(scOut).entries || [],
    track.durationSec,
    '',
  );

  for (const url of scUrls) {
    try {
      await execFileAsync(config.ytdlpPath, [
        '--no-playlist',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '-o',
        rawOut,
        url,
      ]);
      return;
    } catch {
      // Si tiene DRM ("This video is DRM protected"), prueba automáticamente la siguiente
    }
  }

  throw new Error('No encontré una versión libre de derechos para descargar.');
}

export async function downloadTaggedTrack(track) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const rawOut = path.join(os.tmpdir(), `track-${id}.%(ext)s`);
  const rawMp3 = path.join(os.tmpdir(), `track-${id}.mp3`);
  const coverPath = path.join(os.tmpdir(), `cover-${id}.jpg`);
  const finalMp3 = path.join(os.tmpdir(), `final-${id}.mp3`);

  try {
    await searchAndDownloadAudio(track, rawOut);

    let hasCover = false;
    if (track.artworkUrl) {
      try {
        const imgRes = await fetch(track.artworkUrl);
        if (imgRes.ok) {
          await fs.promises.writeFile(coverPath, Buffer.from(await imgRes.arrayBuffer()));
          hasCover = true;
        }
      } catch {}
    }

    const ffmpegArgs = ['-y', '-i', rawMp3];
    if (hasCover) {
      ffmpegArgs.push(
        '-i',
        coverPath,
        '-map',
        '0:0',
        '-map',
        '1:0',
        '-c',
        'copy',
        '-id3v2_version',
        '3',
        '-metadata:s:v',
        'title=Album cover',
        '-metadata:s:v',
        'comment=Cover (front)',
      );
    } else {
      ffmpegArgs.push('-c', 'copy', '-id3v2_version', '3');
    }

    ffmpegArgs.push(
      '-metadata',
      `title=${track.title}`,
      '-metadata',
      `artist=${track.artist}`,
      '-metadata',
      `album=${track.album || track.title}`,
      finalMp3,
    );

    await execFileAsync('ffmpeg', ffmpegArgs);

    const buffer = await fs.promises.readFile(finalMp3);
    const safeName = `${track.artist} - ${track.title}`
      .replace(/[<>:"/\\|?*]/g, '')
      .trim();

    return {
      buffer,
      filename: `${safeName || 'cancion'}.mp3`,
    };
  } finally {
    await fs.promises.unlink(rawMp3).catch(() => {});
    await fs.promises.unlink(coverPath).catch(() => {});
    await fs.promises.unlink(finalMp3).catch(() => {});
  }
}
