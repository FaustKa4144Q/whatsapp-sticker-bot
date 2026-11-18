import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PYTHON_SCRIPT = `
import sys
from PIL import Image, ImageOps

out_pdf = sys.argv[1]
img_paths = sys.argv[2:]
pages = []

for p in img_paths:
    im = Image.open(p)
    im = ImageOps.exif_transpose(im)
    if im.mode != 'RGB':
        im = im.convert('RGB')
    pages.append(im)

if pages:
    pages[0].save(out_pdf, save_all=True, append_images=pages[1:], resolution=150.0)
`;

export async function buildPdfFromImages(imageBuffers) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const tempFiles = [];
  const outPdf = path.join(os.tmpdir(), `wsb-doc-${id}.pdf`);

  try {
    for (let i = 0; i < imageBuffers.length; i++) {
      const imgPath = path.join(os.tmpdir(), `wsb-page-${id}-${i}.jpg`);
      await fs.promises.writeFile(imgPath, imageBuffers[i]);
      tempFiles.push(imgPath);
    }

    await execFileAsync('python3', ['-c', PYTHON_SCRIPT, outPdf, ...tempFiles]);
    return await fs.promises.readFile(outPdf);
  } finally {
    await fs.promises.unlink(outPdf).catch(() => {});
    for (const f of tempFiles) {
      await fs.promises.unlink(f).catch(() => {});
    }
  }
}
