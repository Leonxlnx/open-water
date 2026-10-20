// Verifies GPU wave statistics against the spectrum: Hs = 4*std(eta) summed over cascades.
import { launch, openApp } from './browser.mjs';
const browser = await launch({ width: 400, height: 300 });
try {
  for (const q of ['preset=breeze', 'preset=breeze&wind=15', 'preset=storm']) {
    const page = await openApp(browser, `http://localhost:5173/?render&${q}`, { width: 400, height: 300 });
    const r = await page.evaluate(() => {
      app.frame(1 / 30);
      const gl = app.gl;
      const out = [];
      for (const c of app.ocean.cascades) {
        const fb = c.targets[c.cur].fbo;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.readBuffer(gl.COLOR_ATTACHMENT0);
        const px = new Float32Array(256 * 256 * 4);
        gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.FLOAT, px);
        gl.readBuffer(gl.COLOR_ATTACHMENT1);
        const sl = new Float32Array(256 * 256 * 4);
        gl.readPixels(0, 0, 256, 256, gl.RGBA, gl.FLOAT, sl);
        let s2 = 0, dx2 = 0, mss = 0, maxh = -1e9, minh = 1e9;
        for (let i = 0; i < px.length; i += 4) { s2 += px[i + 1] ** 2; dx2 += px[i] ** 2; maxh = Math.max(maxh, px[i + 1]); minh = Math.min(minh, px[i + 1]); mss += sl[i + 2] + sl[i + 3]; }
        const n = px.length / 4;
        out.push({ L: c.L, std: Math.sqrt(s2 / n), dxStd: Math.sqrt(dx2 / n), max: maxh, min: minh, mss: mss / n });
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const hs = 4 * Math.sqrt(out.reduce((a, c) => a + c.std ** 2, 0));
      return { cascades: out, hsGPU: hs, hsCPU: app.ocean.stats.hs, mssCPU: app.ocean.stats.resolvedMss, bandMss: app.ocean.stats.bandMss };
    });
    console.log(q, JSON.stringify(r, (k, v) => typeof v === 'number' ? +v.toFixed(4) : v));
    await page.close();
  }
} finally { await browser.close(); }
