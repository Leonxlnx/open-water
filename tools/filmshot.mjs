// Render stills from the film timeline: node tools/filmshot.mjs "2,18,30,42,49.15,58" outdir [w h]
import { writeFile, mkdir } from 'node:fs/promises';
import { launch, openApp } from './browser.mjs';

const [times = '2,30,49.15', outDir = 'out/stills', w = '1280', h = '720', q = 'high', extra = ''] = process.argv.slice(2);
const width = Number(w), height = Number(h);
await mkdir(outDir, { recursive: true });
const browser = await launch({ width, height });
try {
  for (const T of times.split(',').map(Number)) {
    const page = await openApp(browser, `http://localhost:5173/?render&q=${q}&scale=1&${extra}`, { width, height });
    const data = await page.evaluate((T) => {
      const dt = 1 / 30;
      // the sea under the frame's weather first: in the film, foam has built up since the act began
      // (as in the film: a cut to a new act starts with 25 s of that act's sea, see App.filmFrame)
      const tw = Math.max(T - 3, 0), W = Math.min(T < 17 ? T : T < 48 ? T - 17 + 25 : T - 48 + 25, 50);
      app.filmFrame(tw, dt);
      app.time = tw - W;
      app.warmSea(W);
      for (let t = Math.max(T - 3, -2); t < T - dt / 2; t += dt) app.filmFrame(t, dt);
      const t0 = performance.now();
      app.filmFrame(T, dt);
      app.gl.finish();
      window.__ms = performance.now() - t0;
      return app.canvas.toDataURL('image/png');
    }, T);
    const file = `${outDir}/film_${String(T).replace('.', '_')}.png`;
    await writeFile(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log(file, (await page.evaluate(() => window.__ms)).toFixed(0) + ' ms');
    await page.close();
  }
} finally {
  await browser.close();
}
