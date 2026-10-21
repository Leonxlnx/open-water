// Probe linear HDR values of a film frame: node tools/probe.mjs T "x,y;x,y" [extra query]
// x, y are fractions of the frame (y from the top). Prints the scene-linear colour and the cloud
// pass (rgb in-scatter, a transmittance) at each point.
import { launch, openApp } from './browser.mjs';

const [T = '24', pts = '0.5,0.4', extra = ''] = process.argv.slice(2);
const width = 960, height = 540;
const browser = await launch({ width, height });
try {
  const page = await openApp(browser, `http://localhost:5173/?render&q=high&scale=1&${extra}`, { width, height });
  const out = await page.evaluate(({ T, pts }) => {
    const dt = 1 / 30;
    for (let t = Math.max(T - 2, -2); t < T - dt / 2; t += dt) app.filmFrame(t, dt);
    app.filmFrame(T, dt);
    const gl = app.gl;
    const read = (tex, fx, fy) => {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex.tex || tex.handle || tex.texture, 0);
      const px = new Float32Array(4);
      gl.readPixels(Math.floor(fx * tex.w), Math.floor((1 - fy) * tex.h), 1, 1, gl.RGBA, gl.FLOAT, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
      return Array.from(px).map((v) => +v.toPrecision(3));
    };
    return pts.split(';').map((p) => {
      const [fx, fy] = p.split(',').map(Number);
      return { p, hdr: read(app.hdr, fx, fy), clouds: read(app.clouds.screen, fx, fy) };
    });
  }, { T: Number(T), pts });
  for (const r of out) console.log(r.p.padEnd(12), 'hdr', JSON.stringify(r.hdr), ' clouds', JSON.stringify(r.clouds));
} finally {
  await browser.close();
}
