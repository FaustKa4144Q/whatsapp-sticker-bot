import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

const JUNK_REGEX = /\b(karaoke|lullaby|tribute|ringtone|8-bit|music box|backing track|instrumental|piano version|cover)\b/i;

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

    // Filtrar versiones de cuna, tributos, karaoke o instrumentales no pedidos
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

async function findMatchingYoutubeUrl(track) {
  const searchQuery = `${track.artist} - ${track.title} official audio`;
  const { stdout } = await execFileAsync(config.ytdlpPath, [
    '--flat-playlist',
    '--dump-single-json',
    `ytsearch5:${searchQuery}`,
  ]);

  const parsed = JSON.parse(stdout);
  const entries = parsed.entries || [];
  if (entries.length === 0) {
    throw new Error('No encontré el audio en YouTube.');
  }

  // Si conocemos la duración oficial, elegimos el video que coincida (±8 segundos)
  if (track.durationSec > 0) {
    const exactMatch = entries.find(
      (e) => e.duration && Math.abs(e.duration - track.durationSec) <= 8,
    );
    if (exactMatch) {
      return exactMatch.url || `https://www.youtube.com/watch?v=${exactMatch.id}`;
    }
  }

  const first = entries[0];
  return first.url || `https://www.youtube.com/watch?v=${first.id}`;
}

export async function downloadTaggedTrack(track) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const rawOut = path.join(os.tmpdir(), `track-${id}.%(ext)s`);
  const rawMp3 = path.join(os.tmpdir(), `track-${id}.mp3`);
  const coverPath = path.join(os.tmpdir(), `cover-${id}.jpg`);
  const finalMp3 = path.join(os.tmpdir(), `final-${id}.mp3`);

  try {
    const ytUrl = await findMatchingYoutubeUrl(track);

    await execFileAsync(config.ytdlpPath, [
      '--no-playlist',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '-o',
      rawOut,
      ytUrl,
    ]);

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
