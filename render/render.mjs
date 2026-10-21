// Offline film render: deterministic frames from headless Chrome (GPU), piped into ffmpeg/x264,
// with the soundtrack rendered by the same audio engine in an OfflineAudioContext.
// Usage: node render/render.mjs [--fps 60] [--w 1920] [--h 1080] [--from 0] [--to 60] [--out out/open-water.mp4]
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { launch, openApp } from '../tools/browser.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, arr) => (v.startsWith('--') ? [...a, [v.slice(2), arr[i + 1] !== undefined && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true']] : a), []));
const wavOf = (p) => { const w = p.replace(/\.[^.\\/]+$/, '') + '.wav'; return w === p ? p + '.audio.wav' : w; };
const fps = Number(args.fps || 60);
const W = Number(args.w || 1920), H = Number(args.h || 1080);
const from = Number(args.from || 0), to = Number(args.to || 60);
const out = resolve(args.out || 'out/open-water.mp4');
const quality = args.q || 'high';
const warm = Number(args.warm || 4);
const crf = args.crf || '15';

await mkdir(dirname(out), { recursive: true });
const browser = await launch({ width: W, height: H });
try {
  const page = await openApp(browser, `http://localhost:5173/?render&q=${quality}&scale=1`, { width: W, height: H });
  const size = await page.evaluate(() => [app.w, app.h]);
  console.log('canvas', size.join('x'));

  if (args.remux) {
    const b64 = await page.evaluate(async () => {
      const buf = new Uint8Array(await app.filmAudio());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const wav = wavOf(out);
    await writeFile(wav, Buffer.from(b64, 'base64'));
    await new Promise((res) => spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', resolve(args.remux), '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
      '-af', 'alimiter=limit=0.84:attack=3:release=60:level=disabled', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' }).on('close', res));
    console.log('remuxed ->', out);
    process.exit(0);
  }

  // soundtrack first (fast), then frames
  const wavPath = wavOf(out);
  if (!args.noaudio) {
    const b64 = await page.evaluate(async () => {
      const buf = new Uint8Array(await app.filmAudio());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    await writeFile(wavPath, Buffer.from(b64, 'base64'));
    console.log('audio ->', wavPath);
  }

  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${size[0]}x${size[1]}`, '-framerate', String(fps), '-i', '-',
    ...(args.noaudio ? [] : ['-ss', String(from), '-i', wavPath]),
    '-vf', 'vflip', '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-x264-params', 'aq-mode=3:deblock=-1,-1', '-tune', 'film',
    ...(args.noaudio ? [] : ['-af', 'alimiter=limit=0.84:attack=3:release=60:level=disabled', '-c:a', 'aac', '-b:a', '256k', '-shortest']),
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });

  // warm-up: settle foam history, cloud accumulation and camera filters before the first frame
  await page.evaluate((from, warm, fps) => {
    const dt = 1 / fps;
    for (let t = from - warm; t < from - dt / 2; t += dt) { app.filmFrame(t, dt); app.gl.finish(); }
  }, from, warm, fps);

  const total = Math.round((to - from) * fps);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = from + i / fps;
    // raw RGBA (lossless, ~3x faster than PNG); rows are bottom-up, flipped by ffmpeg
    const b64 = await page.evaluate((t, dt) => {
      app.filmFrame(t, dt);
      const gl = app.gl;
      const px = (window.__px ||= new Uint8Array(app.w * app.h * 4));
      gl.readPixels(0, 0, app.w, app.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let s = '';
      for (let j = 0; j < px.length; j += 0x8000) s += String.fromCharCode.apply(null, px.subarray(j, j + 0x8000));
      return btoa(s);
    }, t, 1 / fps);
    const buf = Buffer.from(b64, 'base64');
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 30 === 0) {
      const el = (Date.now() - t0) / 1000;
      const eta = (el / (i + 1)) * (total - i - 1);
      console.log(`frame ${i}/${total}  t=${t.toFixed(2)}s  ${(el / (i + 1)).toFixed(2)} s/frame  eta ${Math.round(eta)}s`);
    }
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('done ->', out);
} finally {
  await browser.close();
}
