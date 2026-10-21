// Renders the reference-comparison set (film moments + live presets) at film quality.
// node tools/critique.mjs [outDir] [width height]
import { writeFile, mkdir } from 'node:fs/promises';
import { launch, openApp } from './browser.mjs';

const [outDir = 'out/critique', w = '1600', h = '900'] = process.argv.slice(2);
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
const browser = await launch({ width, height });
try {
  for (const s of SCENES) {
    const url = s.film !== undefined
      ? `http://localhost:5173/?render&q=high&scale=1`
      : `http://localhost:5173/?render&q=high&scale=1&${s.q}`;
    const page = await openApp(browser, url, { width, height });
    const data = await page.evaluate((film) => {
      const dt = 1 / 30;
      if (film !== undefined) {
        for (let t = Math.max(film - 3, -2); t < film - dt / 2; t += dt) app.filmFrame(t, dt);
        app.filmFrame(film, dt);
      } else {
        for (let i = 0; i < 240; i++) app.frame(dt);
      }
      return app.canvas.toDataURL('image/png');
    }, s.film);
    await writeFile(`${outDir}/${s.name}.png`, Buffer.from(data.split(',')[1], 'base64'));
    console.log(s.name);
    await page.close();
  }
} finally {
  await browser.close();
}
