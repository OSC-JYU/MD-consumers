import sharp from 'sharp';
import fs from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import stream from 'node:stream';
import FormData from 'form-data';
import got from 'got';
import { v4 as uuidv4 } from 'uuid';

import { getFile, sendError } from '../funcs.mjs';

const MD_URL = process.env.MD_URL || 'http://localhost:8200';
const DEFAULT_USER = 'local.user@localhost';
const MD_PATH_ENV = process.env.MD_PATH || '';
const DATA_DIR = './data';

// --- MD_PATH resolution (direct file access) ---

function resolveMdRoot(mdPathEnv) {
  if (!mdPathEnv || !String(mdPathEnv).trim()) return null;

  const raw = path.resolve(String(mdPathEnv).trim());
  // Accept both /path/to/MessyDesk and /path/to/MessyDesk/data
  const candidate = path.basename(raw) === 'data' ? path.dirname(raw) : raw;

  try {
    const dataDir = path.join(candidate, 'data');
    if (existsSync(dataDir) && statSync(dataDir).isDirectory()) {
      return candidate;
    }
  } catch { /* fall through */ }

  return null;
}

function resolveFilePath(relativePath) {
  if (!MD_ROOT || !relativePath || !String(relativePath).trim()) return null;
  if (path.isAbsolute(relativePath)) return null;

  const resolved = path.resolve(MD_ROOT, relativePath);
  const root = path.resolve(MD_ROOT);
  if (!resolved.startsWith(root + path.sep)) return null;

  try {
    if (existsSync(resolved)) return resolved;
  } catch { /* fall through */ }

  return null;
}

const MD_ROOT = resolveMdRoot(MD_PATH_ENV);
if (MD_ROOT) {
  console.log(`sharp-thumbnailer: direct file access via MD_PATH = ${MD_ROOT}`);
} else {
  console.log('sharp-thumbnailer: no MD_PATH, using HTTP file download fallback');
}

// --- Thumbnail generation ---

async function createThumbnail(inputPath, width) {
  const outputPath = path.join(DATA_DIR, uuidv4());

  await sharp(inputPath, {
    limitInputPixels: false,
    sequentialRead: true,
    density: 150, // for SVG rasterization
  })
    .rotate()         // auto-orient from EXIF
    .resize({ width, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toFile(outputPath);

  return outputPath;
}

// --- Post result to MessyDesk ---

async function postResult(msg, filePath) {
  const url = `${MD_URL}/api/nomad/process/files`;
  const readStream = fs.createReadStream(filePath);
  const formData = new FormData();
  formData.append('content', readStream);
  formData.append('message', JSON.stringify(msg), {
    contentType: 'application/json',
    filename: 'message.json',
  });

  const headers = formData.getHeaders();
  headers['mail'] = msg.userId || DEFAULT_USER;

  const postStream = got.stream.post(url, {
    body: formData,
    headers,
  });

  await pipeline(postStream, new stream.PassThrough());
}

// --- Cleanup helper ---

function cleanupFile(filePath) {
  try {
    if (filePath && existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.log('cleanup warning:', e.message);
  }
}

// --- Main adapter entry point ---

export async function process_msg(service_url, message) {
  let msg;
  const start = process.hrtime();
  let previewPath = null;
  let thumbPath = null;
  let downloadedPath = null;

  try {
    msg = message.json();
  } catch (e) {
    console.log('invalid message payload!', e.message);
    await sendError({}, { error: 'invalid message payload!' }, MD_URL, DEFAULT_USER);
    return;
  }

  try {
    console.log('**************** sharp-thumbnailer ***************');

    if (!msg.file) {
      throw new Error('No file found in message');
    }

    // --- Resolve input file path ---
    let inputPath = resolveFilePath(msg.file?.path);

    if (!inputPath) {
      // Fallback: download via HTTP
      console.log('direct FS not available, downloading via HTTP...');
      downloadedPath = await getFile(MD_URL, msg.file['@rid'], msg.userId || DEFAULT_USER);
      inputPath = downloadedPath;
    } else {
      console.log('using direct file access:', inputPath);
    }

    // --- Generate preview (800px) ---
    const previewWidth = Number(msg.task?.params?.width) || 800;
    previewPath = await createThumbnail(inputPath, previewWidth);

    const end = process.hrtime(start);
    const seconds = (end[0] + end[1] / 1e9).toFixed(3);
    console.log(`preview generated in ${seconds}s`);

    msg.file_total = 1;
    msg.file_count = 1;
    msg.response = { time: parseFloat(seconds) };

    await postResult(msg, previewPath);
    console.log('preview sent');

    // --- Generate thumbnail (200px) ---
    thumbPath = await createThumbnail(inputPath, 200);
    msg.thumb_name = 'thumbnail.jpg';
    await postResult(msg, thumbPath);
    console.log('thumbnail sent');

  } catch (error) {
    console.error('sharp-thumbnailer error:', error.message);
    sendError(msg || {}, error, MD_URL, msg?.userId || DEFAULT_USER);
  } finally {
    // Cleanup temp files
    cleanupFile(previewPath);
    cleanupFile(thumbPath);
    cleanupFile(downloadedPath);
  }
}
