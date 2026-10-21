// Deterministic screenshot: node tools/shot.mjs "<query>" out.png [width height warmupSeconds]
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { launch, openApp } from './browser.mjs';

const [query = '', out = 'shot.png', w = '1600', h = '900', warm = '6'] = process.argv.slice(2);
const width = Number(w), height = Number(h);
const browser = await launch({ width, height });
try {
  const page = await openApp(browser, `http://localhost:5173/?render&${query}`, { width, height });
  const info = await page.evaluate(async (warmSeconds) => {
    const dt = 1 / 30;
    const n = Math.round(warmSeconds / dt);
    const t0 = performance.now();
    if (warmSeconds > 10) app.warmSea(warmSeconds - 4);
    for (let i = 0; i < (warmSeconds > 10 ? Math.round(4 / dt) : n); i++) app.frame(dt);
    app.gl.finish();
    const ms = (performance.now() - t0) / n;
    const gl = app.gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return { msPerFrame: ms.toFixed(1), gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '?', stats: app.stats, prof: app.prof.report() };
  }, Number(warm));
  const data = await page.evaluate(() => app.canvas.toDataURL('image/png'));
  await mkdir(dirname(out), { recursive: true }).catch(() => {});
  await writeFile(out, Buffer.from(data.split(',')[1], 'base64'));
  console.log(JSON.stringify(info));
} finally {
  await browser.close();
}
