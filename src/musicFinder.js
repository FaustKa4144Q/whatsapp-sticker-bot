import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';

const execFileAsync = promisify(execFile);

export async function searchTracks(query) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=5`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Error buscando la canción');
  const data = await res.json();

  return (data.results || []).map((item) => ({
    title: item.trackName,
    artist: item.artistName,
    album: item.collectionName || item.trackName,
    coverUrl: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
  }));
}

export async function downloadTaggedTrack(track) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const rawTemplate = path.join(os.tmpdir(), `wsb-raw-${id}.%(ext)s`);
  const rawMp3 = path.join(os.tmpdir(), `wsb-raw-${id}.mp3`);
  const coverPath = path.join(os.tmpdir(), `wsb-cov-${id}.jpg`);
  const finalMp3 = path.join(os.tmpdir(), `wsb-tag-${id}.mp3`);

  try {
    const searchQuery = `ytsearch1:${track.artist} - ${track.title} audio`;
    await execFileAsync(config.ytdlpPath, [
      '--no-playlist',
      '-x',
      '--audio-format',
      'mp3',
      '--audio-quality',
      '0',
      '-o',
      rawTemplate,
      searchQuery,
    ]);

    let hasCover = false;
    if (track.coverUrl) {
      const imgRes = await fetch(track.coverUrl);
      if (imgRes.ok) {
        await fs.promises.writeFile(coverPath, Buffer.from(await imgRes.arrayBuffer()));
        hasCover = true;
      }
    }

    const ffmpegArgs = ['-y', '-i', rawMp3];
    if (hasCover) {
      ffmpegArgs.push('-i', coverPath, '-map', '0:0', '-map', '1:0');
    }
    ffmpegArgs.push(
      '-c',
      'copy',
      '-id3v2_version',
      '3',
      '-metadata',
      `title=${track.title}`,
      '-metadata',
      `artist=${track.artist}`,
      '-metadata',
      `album=${track.album}`,
      finalMp3,
    );

    await execFileAsync('ffmpeg', ffmpegArgs);

    const safeName = `${track.artist} - ${track.title}`
      .replace(/[/\\?%*:|"<>]/g, '')
      .trim();

    return {
      buffer: await fs.promises.readFile(finalMp3),
      filename: `${safeName}.mp3`,
    };
  } finally {
    await fs.promises.unlink(rawMp3).catch(() => {});
    await fs.promises.unlink(coverPath).catch(() => {});
    await fs.promises.unlink(finalMp3).catch(() => {});
  }
}
