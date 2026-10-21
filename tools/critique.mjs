// Renders the reference-comparison set (film moments + live presets) at film quality.
// node tools/critique.mjs [outDir] [width height]
import { writeFile, mkdir } from 'node:fs/promises';
import { launch, openApp } from './browser.mjs';

const [outDir = 'out/critique', w = '1600', h = '900', only = ''] = process.argv.slice(2);
const width = Number(w), height = Number(h);

export const SCENES = [
  { name: 'film-golden-hour', film: 3 },
  { name: 'film-squall-approach', film: 25 },
  { name: 'film-under-shelf', film: 31 },
  { name: 'film-lightning', film: 39.25 },
  { name: 'film-gale-rain', film: 44 },
  { name: 'film-moonlit-night', film: 52 },
  { name: 'noon-open-ocean', q: 'preset=calm&wind=6&elev=58&az=180&yaw=10&pitch=-9&h=3&clouds=0.15' },
  { name: 'breeze-sun-glitter', q: 'preset=breeze&elev=26&az=200&yaw=200&pitch=1&h=3' },
  { name: 'deck-beaufort-5', q: 'preset=breeze&elev=35&az=200&yaw=20&pitch=-12&h=14&float=0' },
  { name: 'deck-beaufort-7', q: 'preset=breeze&wind=15&fetch=1200&elev=35&az=200&yaw=20&pitch=-12&h=14&float=0' },
  { name: 'deck-beaufort-9', q: 'preset=storm&rain=0&mist=0&elev=35&az=200&yaw=20&pitch=-12&h=14&float=0' },
  { name: 'rain-on-sea-closeup', q: 'preset=rain&wind=7&elev=30&az=200&yaw=60&pitch=-18&h=2.2' },
  { name: 'overcast-grey-sea', q: 'preset=calm&wind=9&clouds=0.95&cloudDark=0.35&elev=35&az=200&yaw=40&pitch=0&h=3' },
];

await mkdir(outDir, { recursive: true });
// one browser per scene (a GPU reset must not take the remaining scenes with it), one retry
async function renderScene(s) {
  const browser = await launch({ width, height });
  try {
    const url = s.film !== undefined
      ? `http://localhost:5173/?render&q=high&scale=1`
      : `http://localhost:5173/?render&q=high&scale=1&${s.q}`;
    const page = await openApp(browser, url, { width, height });
    return await page.evaluate(async (film) => {
      const dt = 1 / 30;
      // let the GPU drain between frames (a long queue of heavy frames trips the GPU watchdog)
      const step = async (f) => { f(); app.gl.finish(); await new Promise((r) => setTimeout(r, 0)); };
      if (film !== undefined) {
        // the sea under the frame's weather first: in the film, foam has built up since the act began
        // (as in the film: a cut to a new act starts with 25 s of that act's sea, see App.filmFrame)
        const t0 = Math.max(film - 3, 0), W = Math.min(film < 17 ? film : film < 48 ? film - 17 + 25 : film - 48 + 25, 50);
        app.filmFrame(t0, dt);
        app.time = t0 - W;  // continuous wave phase: the warm-up ends exactly where the frames resume
        app.warmSea(W);
        for (let t = Math.max(film - 3, -2); t < film - dt / 2; t += dt) await step(() => app.filmFrame(t, dt));
        app.filmFrame(film, dt);
      } else {
        // the sea first (foam takes up to a minute to reach its steady state), then the sky history
        app.warmSea(50);
        for (let i = 0; i < 120; i++) await step(() => app.frame(dt));
      }
      return app.canvas.toDataURL('image/png');
    }, s.film);
  } finally {
    await browser.close();
  }
}
for (const s of SCENES) {
  if (only && !only.split(',').includes(s.name)) continue;
  let data;
  try { data = await renderScene(s); } catch (e) { console.log(`retry ${s.name}: ${e.message}`); data = await renderScene(s); }
  await writeFile(`${outDir}/${s.name}.png`, Buffer.from(data.split(',')[1], 'base64'));
  console.log(s.name);
  // a pause between scenes: the GPU is shared and heavy back-to-back frames have reset its driver
  await new Promise((r) => setTimeout(r, 15000));
}