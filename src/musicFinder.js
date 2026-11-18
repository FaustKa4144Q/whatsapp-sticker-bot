import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

const JUNK_REGEX =
  /\b(karaoke|lullaby|tribute|ringtone|8-bit|music box|backing track|instrumental|piano version|cover)\b/i;

const YTDLP_COMMON_ARGS = [
  '--no-playlist',
  '--js-runtimes',
  'node',
  '--extractor-args',
  'youtube:player_client=android_vr,ios,web',
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

function pickBestEntry(entries, durationSec, fallbackPrefix) {
  if (!entries || entries.length === 0) return null;

  if (durationSec > 0) {
    const exact = entries.find(
      (e) => e.duration && Math.abs(e.duration - durationSec) <= 10,
    );
    if (exact) {
      return exact.webpage_url || exact.url || `${fallbackPrefix}${exact.id}`;
    }
  }

  const first = entries[0];
  return first.webpage_url || first.url || `${fallbackPrefix}${first.id}`;
}

async function searchAndDownloadAudio(track, rawOut) {
  const query = `${track.artist} - ${track.title}`;

  try {
    const { stdout } = await execFileAsync(config.ytdlpPath, [
      ...YTDLP_COMMON_ARGS,
      '--flat-playlist',
      '--dump-single-json',
      `ytsearch5:${query} audio`,
    ]);
    const ytEntries = JSON.parse(stdout).entries || [];
    const ytUrl = pickBestEntry(ytEntries, track.durationSec, 'https://www.youtube.com/watch?v=');

    if (ytUrl) {
      await execFileAsync(config.ytdlpPath, [
        ...YTDLP_COMMON_ARGS,
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '-o',
        rawOut,
        ytUrl,
      ]);
      return;
    }
  } catch {
    // Respaldo automático en SoundCloud si YouTube bloquea la IP
  }

  const { stdout: scOut } = await execFileAsync(config.ytdlpPath, [
    '--no-playlist',
    '--flat-playlist',
    '--dump-single-json',
    `scsearch5:${query}`,
  ]);
  const scEntries = JSON.parse(scOut).entries || [];
  const scUrl = pickBestEntry(scEntries, track.durationSec, '');
  if (!scUrl) {
    throw new Error('No encontré el audio disponible para descargar.');
  }

  await execFileAsync(config.ytdlpPath, [
    '--no-playlist',
    '-x',
    '--audio-format',
    'mp3',
    '--audio-quality',
    '0',
    '-o',
    rawOut,
    scUrl,
  ]);
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
