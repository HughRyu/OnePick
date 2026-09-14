import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as slideshow from '../src/slideshow.js';
assert.equal(typeof slideshow.renderSlideshow, 'function');
const root = '/tmp/onepick-slideshow';
fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(`${root}/fixture-`);
const run = args => execFileSync('ffmpeg', ['-v','error','-y',...args], { timeout: 20000 });
try {
  run(['-f','lavfi','-i','color=c=red:s=320x240','-frames:v','1',`${dir}/red.png`]);
  run(['-f','lavfi','-i','sine=frequency=440:duration=3','-c:a','libmp3lame',`${dir}/audio.mp3`]);
  fs.writeFileSync(`${dir}/playlist.mp3`, `ffconcat version 1.0\nfile '${dir}/audio.mp3'\n`);
  await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/playlist.mp3`, tempDir: dir }), /Unsupported|不支持/);
  const huge = fs.readFileSync(`${dir}/red.png`); huge.writeUInt32BE(50000, 16);
  fs.writeFileSync(`${dir}/huge.png`, huge);
  await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/huge.png`], audio: `${dir}/audio.mp3`, tempDir: dir }), /dimensions/);
  const result = await slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/audio.mp3`, tempDir: dir, signal: new AbortController().signal });
  const probe = JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',result.path]));
  assert.equal(probe.streams[0].codec_name,'h264');
  assert.equal(probe.streams[0].pix_fmt,'yuv420p');
  assert.equal(probe.streams[1].codec_name,'aac');
  assert.ok(Math.abs(Number(probe.format.duration)-3)<0.2);
  assert.ok(Math.abs(Date.parse(probe.format.tags.creation_time)-Date.now())<30000);
  run(['-f','lavfi','-i','color=c=blue:s=240x320','-frames:v','1',`${dir}/blue.png`]);
  const multi = await slideshow.renderSlideshow({ images: [`${dir}/red.png`, `${dir}/blue.png`], audio: `${dir}/audio.mp3`, tempDir: dir });
  const pixel = time => execFileSync('ffmpeg',['-v','error','-ss',String(time),'-i',multi.path,'-frames:v','1','-vf','crop=2:2:360:640','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
  assert.ok(pixel(0.5)[0] > 200);
  assert.ok(pixel(2.5)[2] > 200);
  // A relative local-reference playlist was previously accepted by auto-detection.
  fs.writeFileSync(`${dir}/local.m3u`, '#EXTM3U\n#EXTINF:3,secret\naudio.mp3\n');
  fs.writeFileSync(`${dir}/relative.ffconcat`, 'ffconcat version 1.0\nfile audio.mp3\n');
  for (const file of ['local.m3u', 'relative.ffconcat', 'playlist.mp3']) {
    await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/${file}`, tempDir: dir }), /Unsupported/);
    await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/${file}`], audio: `${dir}/audio.mp3`, tempDir: dir }), /Unsupported/);
  }
  for (const ext of ['jpg', 'webp']) {
    run(['-i',`${dir}/red.png`,'-frames:v','1',`${dir}/image.${ext}`]);
    await slideshow.renderSlideshow({ images: [`${dir}/image.${ext}`], audio: `${dir}/audio.mp3`, tempDir: dir });
  }
  for (const ext of ['aac', 'wav']) {
    run(['-i',`${dir}/audio.mp3`,`${dir}/audio.${ext}`]);
    await slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/audio.${ext}`, tempDir: dir });
  }
  run(['-i',`${dir}/audio.mp3`,`${dir}/audio.m4a`]);
  await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/audio.m4a`, tempDir: dir }), /Unsupported/);
  const hugeJpeg = Buffer.from([255,216,255,192,0,8,8,0,1,255,255,1,255,218]);
  const hugeWebp = Buffer.alloc(30);
  hugeWebp.write('RIFF'); hugeWebp.writeUInt32LE(22,4); hugeWebp.write('WEBPVP8 ',8); hugeWebp.writeUInt32LE(10,16);
  Buffer.from([0x9d,1,0x2a]).copy(hugeWebp,23); hugeWebp.writeUInt16LE(16383,26); hugeWebp.writeUInt16LE(16383,28);
  const hugePixels = fs.readFileSync(`${dir}/red.png`); hugePixels.writeUInt32BE(6000,16); hugePixels.writeUInt32BE(6000,20);
  for (const [i, bytes] of [hugeJpeg, hugeWebp, hugePixels].entries()) {
    fs.writeFileSync(`${dir}/huge-${i}`,bytes);
    await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/huge-${i}`], audio: `${dir}/audio.mp3`, tempDir: dir }), /dimensions/);
  }
  // Abort a live final encoder, not just an already-aborted call.
  run(['-f','lavfi','-i','sine=frequency=440:duration=600','-c:a','libmp3lame',`${dir}/long.mp3`]);
  fs.rmSync(`${dir}/slideshow.mp4`, { force: true });
  const active = new AbortController();
  const rendering = slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/long.mp3`, tempDir: dir, signal: active.signal });
  const rejected = assert.rejects(rendering, { name: 'AbortError' });
  let pid;
  const deadline = Date.now() + 15000;
  while (!pid && Date.now() < deadline) {
    const children = fs.readFileSync(`/proc/${process.pid}/task/${process.pid}/children`,'utf8').trim().split(/\s+/).filter(Boolean);
    for (const child of children) {
      try {
        const cmd = fs.readFileSync(`/proc/${child}/cmdline`,'utf8');
        if (cmd.includes('ffmpeg') && cmd.includes('concat') && fs.existsSync(`${dir}/slideshow.mp4`) && fs.statSync(`${dir}/slideshow.mp4`).size > 0) pid = child;
      } catch {}
    }
    if (!pid) await new Promise(resolve => setTimeout(resolve,10));
  }
  try {
    assert.ok(pid, 'observed a live final ffmpeg encoder');
    assert.match(fs.readFileSync(`/proc/${pid}/limits`,'utf8'), /Max address space\s+1073741824\s+1073741824/);
  } finally { active.abort(); }
  await rejected;
  for (let i = 0; i < 100 && fs.existsSync(`/proc/${pid}`); i++) await new Promise(resolve => setTimeout(resolve,10));
  assert.ok(!fs.existsSync(`/proc/${pid}`), 'aborted ffmpeg was reaped');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(slideshow.renderSlideshow({ images: [`${dir}/red.png`], audio: `${dir}/audio.mp3`, tempDir: dir, signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(slideshow.renderSlideshow({ images: [], audio: `${dir}/audio.mp3`, tempDir: dir }));
  const parsed = { platform: { id: 'douyin' }, items: [{ type:'image',url:'image' }, {type:'audio',url:'audio'}] };
  assert.equal(slideshow.shortcutSlideshow(parsed).images.length, 1);
  assert.equal(slideshow.shortcutSlideshow(parsed,{mode:'audio'}), null);
  assert.equal(slideshow.shortcutSlideshow({...parsed,platform:{id:'other'}}), null);
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
console.log('Douyin slideshow real ffmpeg fixture passed');
