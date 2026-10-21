// Probe linear HDR colour at points of a preset/query scene: node tools/probeq.mjs "query" "x,y;x,y" [warmSeconds]
// Also prints the scene's sky irradiance (env) and sun illuminance used for lighting.
import { launch, openApp } from './browser.mjs';

const [q = 'preset=rain', pts = '0.5,0.1', warm = '6'] = process.argv.slice(2);
const width = 640, height = 360;
const browser = await launch({ width, height });
try {
  const page = await openApp(browser, `http://localhost:5173/?render&q=high&scale=1&${q}`, { width, height });
  const out = await page.evaluate(({ pts, warm }) => {
    for (let i = 0; i < Math.round(warm * 30); i++) app.frame(1 / 30);
    const gl = app.gl;
    const read = (tex, fx, fy) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex, 0);
      const px = new Float32Array(4);
      gl.readPixels(Math.floor(fx * (tex.w - 1)), Math.floor((1 - fy) * (tex.h - 1)), 1, 1, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      return Array.from(px).map((v) => +v.toPrecision(3));
    };
    const res = pts.split(';').map((p) => { const [fx, fy] = p.split(',').map(Number); return { p, hdr: read(app.hdr, fx, fy) }; });
    res.push({ p: 'skyIrradiance', hdr: read(app.sky.irradiance, 0, 0) });
    res.push({ p: 'deckIrradiance', hdr: read(app.sky.irradiance, 1, 0) });
    // cloud buffer (rgb in-scatter, a transmittance) and mean cloud distance (km) at the points
    for (const p of pts.split(';')) { const [fx, fy] = p.split(',').map(Number); res.push({ p: 'cl ' + p, hdr: read(app.clouds.screen, fx, fy) }, { p: 'cd ' + p, hdr: read(app.clouds.depth, fx, fy) }); }
    return res;
  }, { pts, warm: Number(warm) });
  for (const r of out) console.log(r.p.padEnd(14), JSON.stringify(r.hdr));
} finally {
  await browser.close();
}
