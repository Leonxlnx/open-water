// Tonal statistics (luma 10th/50th/90th percentile, mean, saturation) of images, via ffmpeg's
// signalstats. Used to match exposure and contrast of renders to reference photographs.
// node tools/tonestats.mjs a.png b.jpg ...
import { spawnSync } from 'node:child_process';

export function stats(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf',
    'scale=640:-2,format=yuv444p,signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
  const get = (k) => { const m = new RegExp(`lavfi\\.signalstats\\.${k}=([0-9.]+)`).exec(r.stdout + r.stderr); return m ? +m[1] : NaN; };
  return { low: get('YLOW'), avg: get('YAVG'), high: get('YHIGH'), max: get('YMAX'), sat: get('SATAVG'), hue: get('HUEAVG') };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('tonestats.mjs')) {
  for (const f of process.argv.slice(2)) {
    const s = stats(f);
    console.log(`${f.split(/[\\/]/).pop().padEnd(44)} p10 ${s.low.toFixed(0).padStart(3)}  mean ${s.avg.toFixed(0).padStart(3)}  p90 ${s.high.toFixed(0).padStart(3)}  max ${s.max.toFixed(0).padStart(3)}  sat ${s.sat.toFixed(1).padStart(5)}  hue ${s.hue.toFixed(0)}`);
  }
}
