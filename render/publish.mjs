// Prepares the film for the repository: a web encode (~5 Mbit/s, fits in git) and poster stills.
// node render/publish.mjs out/open-water.mp4
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const [src = 'out/open-water.mp4'] = process.argv.slice(2);
mkdirSync('media', { recursive: true });
const ff = (...a) => {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
};
// two-pass x264 at 8 Mbit/s: 60 s of 1080p60 near 60 MB (under GitHub's 100 MB file limit) keeps rain and foam crisp
ff('-i', src, '-c:v', 'libx264', '-preset', 'slow', '-b:v', '8000k', '-pass', '1', '-an', '-f', 'mp4', process.platform === 'win32' ? 'NUL' : '/dev/null');
ff('-i', src, '-c:v', 'libx264', '-preset', 'slow', '-b:v', '8000k', '-maxrate', '14000k', '-bufsize', '16000k', '-pass', '2',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'media/open-water.mp4');
for (const [t, name] of [[3, 'golden-hour'], [19, 'squall'], [31.5, 'shelf'], [39.25, 'lightning'], [44, 'storm'], [55.2, 'night']]) {
  ff('-ss', String(t), '-i', src, '-frames:v', '1', '-q:v', '3', `media/${name}.jpg`);
}
console.log('media/ ready');
