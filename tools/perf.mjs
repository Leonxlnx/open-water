// Performance: GPU time per pass via timer queries (yielding between frames so queries resolve)
// and wall time per frame with gl.finish(). Usage: node tools/perf.mjs "preset=storm" 1920 1080
import { launch, openApp } from './browser.mjs';

const [query = 'preset=breeze', w = '1920', h = '1080'] = process.argv.slice(2);
const width = Number(w), height = Number(h);
const browser = await launch({ width, height });
try {
  const page = await openApp(browser, `http://localhost:5173/?render&profile&${query}`, { width, height });
  const r = await page.evaluate(async () => {
    const wall = [];
    for (let i = 0; i < 150; i++) {
      const t0 = performance.now();
      app.frame(1 / 60);
      app.gl.finish();
      wall.push(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 0));
    }
    const s = wall.slice(30).sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    const gpu = app.prof.report();
    const total = Object.values(gpu).reduce((a, b) => a + b, 0);
    return { medianMs: +med.toFixed(1), fps: +(1000 / med).toFixed(1), gpuTotalMs: +total.toFixed(1), gpu, size: [app.w, app.h] };
  });
  console.log(query, JSON.stringify(r));
} finally {
  await browser.close();
}
