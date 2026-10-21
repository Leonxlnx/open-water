// Side-by-side comparison of a render and a reference photo (same crop and size), with labels.
// node tools/compare.mjs render.png reference.jpg out.png [width height]
import { spawnSync } from 'node:child_process';

const [a, b, out, w = '800', h = '450'] = process.argv.slice(2);
const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
const label = (t) => `drawtext=text='${t}':x=14:y=12:fontsize=18:fontcolor=white@0.85:box=1:boxcolor=black@0.35:boxborderw=6`;
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', a, '-i', b, '-filter_complex',
  `[0]${fit},${label('render')}[x];[1]${fit},${label('photo')}[y];[x][y]hstack`, out], { stdio: 'inherit' });
process.exit(r.status ?? 1);
