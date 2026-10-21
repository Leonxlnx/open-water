// Contact sheet of a video: node tools/contact.mjs film.mp4 out.png [times=2,10,...] [cols=3]
import { spawnSync } from 'node:child_process';

const [video, out, times = '3,12,24,31,36,41,46,51,57', cols = '3'] = process.argv.slice(2);
const T = times.split(',').map(Number);
const inputs = T.flatMap((t) => ['-ss', String(t), '-i', video]);
const n = T.length, c = Number(cols), w = 640, h = 360;
const scale = T.map((_, i) => `[${i}:v]trim=end_frame=1,scale=${w}:${h},drawtext=text='${T[i]}s':x=10:y=8:fontsize=18:fontcolor=white@0.8:box=1:boxcolor=black@0.35:boxborderw=4[v${i}]`).join(';');
const layout = T.map((_, i) => `${(i % c) * w}_${Math.floor(i / c) * h}`).join('|');
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, '-filter_complex',
  `${scale};${T.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${n}:layout=${layout}`, '-frames:v', '1', out], { stdio: 'inherit' });
process.exit(r.status ?? 1);
