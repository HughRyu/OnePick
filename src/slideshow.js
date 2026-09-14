import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
export function shortcutSlideshow(parsed, preferences = {}) {
  if (parsed.platform?.id !== 'douyin' || preferences.mode === 'audio') return null;
  const images = (parsed.items || []).filter(item => item.type === 'image' && item.url);
  const audio = (parsed.items || []).find(item => item.type === 'audio' && item.url);
  return images.length && audio && !parsed.items.some(item => item.type === 'video') ? { images, audio } : null;
}

// Never sniff a container with ffprobe: playlists can refer to local secrets.
// Deliberately reject MOV/M4A (external data references) until a complete box
// validator exists. WAV is a single-file RIFF stream, not a reference container.
function audioFormat(b) {
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  let offset = 0;
  if (b.toString('ascii', 0, 3) === 'ID3') {
    if (b.length < 10 || b[3] < 2 || b[3] > 4 || [...b.subarray(6, 10)].some(n => n & 128)) throw new Error('Unsupported audio signature');
    offset = 10 + b[6] * 2097152 + b[7] * 16384 + b[8] * 128 + b[9];
    if (b[3] === 4 && (b[5] & 16)) offset += 10;
  }
  if (offset + 4 <= b.length && b[offset] === 255) {
    const x = b[offset + 1], y = b[offset + 2];
    if ((x & 0xf6) === 0xf0 && ((y >> 2) & 15) < 13) return 'aac';
    if ((x & 0xe0) === 0xe0 && (x & 0x18) !== 8 && (x & 6) !== 0 && (y >> 4) > 0 && (y >> 4) < 15 && (y & 12) !== 12) return 'mp3';
  }
  throw new Error('Unsupported audio signature (playlists and M4A are not supported)');
}

function imageFormat(b) {
  const dimensions = (w, h) => {
    if (!w || !h || w > 8192 || h > 8192 || w * h > 24000000) throw new Error('Image dimensions exceed limits');
  };
  if (b.length >= 33 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.readUInt32BE(8) === 13 && b.toString('ascii', 12, 16) === 'IHDR') {
    dimensions(b.readUInt32BE(16), b.readUInt32BE(20));
    return 'png_pipe';
  }
  if (b[0] === 255 && b[1] === 216) {
    let p = 2, found = false;
    while (p < b.length) {
      if (b[p++] !== 255) break;
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 0xda) { if (found) return 'jpeg_pipe'; break; }
      if (p + 2 > b.length) break;
      const size = b.readUInt16BE(p);
      if (size < 2 || p + size > b.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8) break;
        dimensions(b.readUInt16BE(p + 5), b.readUInt16BE(p + 3)); found = true;
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) break;
      p += size;
    }
  }
  if (b.length >= 20 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.readUInt32LE(4) + 8 === b.length) {
    let found = false;
    for (let p = 12; p + 8 <= b.length;) {
      const type = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4), q = p + 8;
      if (q + n > b.length) break;
      if (type === 'ANIM' || type === 'ANMF') throw new Error('Unsupported animated image');
      if (type === 'VP8X' && n >= 10) {
        if (b[q] & 2) throw new Error('Unsupported animated image');
        dimensions(b.readUIntLE(q + 4, 3) + 1, b.readUIntLE(q + 7, 3) + 1);
      }
      if (type === 'VP8 ' && n >= 10 && b.subarray(q + 3, q + 6).equals(Buffer.from([0x9d, 1, 0x2a]))) {
        dimensions(b.readUInt16LE(q + 6) & 0x3fff, b.readUInt16LE(q + 8) & 0x3fff); found = true;
      }
      if (type === 'VP8L' && n >= 5 && b[q] === 0x2f) {
        const bits = b.readUInt32LE(q + 1);
        dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); found = true;
      }
      p = q + n + (n & 1);
    }
    if (found) return 'webp_pipe';
  }
  throw new Error('Unsupported image signature or dimensions');
}

function readMedia(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > limit) throw new Error('Invalid media file size');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

// Local files only: remote URLs never reach ffmpeg. Caller owns directory and deadline.
export async function renderSlideshow({ images, audio, tempDir, signal, maxBytes = 256 * 1024 * 1024 }) {
  if (!images.length || images.length > 50) throw new Error('图文图片数量超限。');
  const audioDemuxer = audioFormat(readMedia(audio, 64 * 1024 * 1024));
  const imageDemuxers = images.map(file => imageFormat(readMedia(file, 20 * 1024 * 1024)));
  const options = { timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, signal };
  const bounded = (tool, args, opts = options) => new Promise((resolve, reject) => {
    // execFile's AbortSignal rejects before child close; wait for reaping so the
    // caller can safely remove its work directory and release concurrency slots.
    signal?.throwIfAborted();
    let failure, stdout;
    const child = execFile('prlimit', ['--as=1073741824:1073741824', '--', tool, ...args], { ...opts, signal: undefined, env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } }, (error, out) => { failure = error; stdout = out; });
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(Object.assign(new Error('Slideshow aborted'), { name: 'AbortError' }));
      else if (failure) reject(failure);
      else resolve({ stdout });
    });
    if (signal?.aborted) abort();
  });
  const run = args => bounded('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-max_alloc', '134217728', '-filter_threads', '1', ...args], options);
  const { stdout } = await bounded('ffprobe', ['-v','error','-protocol_whitelist','file','-f',audioDemuxer,'-threads','1','-show_entries','format=duration','-of','json',audio], { ...options, timeout: 10000 });
  const duration = Number(JSON.parse(stdout).format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new Error('图文音频时长无效或超过 30 分钟。');
  for (let i = 0; i < images.length; i++) {
    await run(['-protocol_whitelist','file','-f',imageDemuxers[i],'-threads','1','-i',images[i],'-frames:v','1','-vf',"scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1",'-threads','1',path.join(tempDir,`slide-${i}.png`)]);
  }
  // Only this application-generated manifest may use concat; never uploaded bytes.
  const manifest = images.map((_,i) => `file slide-${i}.png\nduration ${duration/images.length}\n`).join('') + `file slide-${images.length-1}.png\n`;
  fs.writeFileSync(path.join(tempDir,'slides.txt'), manifest);
  const output = path.join(tempDir,'slideshow.mp4');
  const creationTime = new Date().toISOString();
  await run(['-protocol_whitelist','file,pipe','-f','concat','-safe','1','-i',path.join(tempDir,'slides.txt'),'-protocol_whitelist','file','-f',audioDemuxer,'-threads','1','-i',audio,'-map','0:v:0','-map','1:a:0','-t',String(duration),'-vf','fps=2','-c:v','libx264','-preset','ultrafast','-tune','stillimage','-crf','23','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-map_metadata','-1','-metadata',`creation_time=${creationTime}`,'-movflags','+faststart','-fs',String(maxBytes),output]);
  if (fs.statSync(output).size >= maxBytes) throw new Error('图文视频超过大小限制。');
  return { path: output, duration, creationTime };
}

