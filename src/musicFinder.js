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

export async function searchTracks(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=20&country=MX`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Error buscando música (${res.status})`);

  const data = await res.json();
  const userWantsCover = JUNK_REGEX.test(query);
  const seen = new Set();
  const clean = [];

  for (const item of data.results || []) {
    const title = (item.trackName || '').trim();
    const artist = (item.artistName || '').trim();
    if (!title || !artist) continue;

    if (!userWantsCover && (JUNK_REGEX.test(title) || JUNK_REGEX.test(artist))) {
      continue;
    }

    const key = `${title.toLowerCase()}|${artist.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    clean.push({
      title,
      artist,
      album: (item.collectionName || title).trim(),
      durationSec: Math.round((item.trackTimeMillis || 0) / 1000),
      artworkUrl: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
    });

    if (clean.length === 5) break;
  }

  return clean;
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

  // 1. Intento principal en YouTube con cliente móvil y runtime Node
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
    // Si YouTube bloquea la IP del servidor ("Sign in to confirm"), pasamos a SoundCloud
  }

  // 2. Respaldo automático en SoundCloud (sin bloqueos de bot en Railway)
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
