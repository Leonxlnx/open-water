// Mean sRGB of horizontal bands of an image (fractions of its height), to compare the colour of
// sky, far sea and near sea between renders and reference photographs.
// node tools/regions.mjs img... [--bands 0-0.3,0.45-0.5,0.8-1]
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const bi = args.indexOf('--bands');
const bands = (bi >= 0 ? args.splice(bi, 2)[1] : '0-0.25,0.4-0.48,0.52-0.62,0.8-1').split(',').map((b) => b.split('-').map(Number));
for (const f of args) {
  const cols = bands.map(([a, b]) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', f, '-vf',
      `crop=iw:ih*${(b - a).toFixed(4)}:0:ih*${a.toFixed(4)},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 20 });
    const p = r.stdout;
    return p && p.length >= 3 ? `${p[0]},${p[1]},${p[2]}`.padEnd(12) : '?'.padEnd(12);
  });
  console.log(`${f.split(/[\\/]/).pop().slice(0, 34).padEnd(36)}${cols.join(' ')}`);
}
