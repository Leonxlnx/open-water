// Live-mode smoke test: UI loads, presets switch, sound turns on, lightning + thunder fire,
// and the render loop keeps running throughout. node tools/livetest.mjs
import { launch, openApp } from './browser.mjs';

const browser = await launch({ width: 1280, height: 720 });
const errors = [];
try {
  const page = await openApp(browser, 'http://localhost:5173/', { width: 1280, height: 720 });
  page.on('pageerror', (e) => errors.push(e.message));
  const t = async () => page.evaluate(() => app.time);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const checks = [];
  const advance = async (label, ms = 1500) => {
    const a = await t(); await wait(ms); const b = await t();
    checks.push([label, +(b - a).toFixed(2)]);
  };
  await advance('initial loop');
  await page.click('.sound');
  await wait(1500);
  await advance('after sound on');
  const audio = await page.evaluate(() => ({ state: document.querySelector('.sound').classList.contains('muted') ? 'muted' : 'on' }));
  await page.click('[data-preset="storm"]');
  await advance('storm preset', 2500);
  await page.keyboard.press('l');
  await advance('lightning strike', 2000);
  await page.keyboard.press('n');
  await advance('night', 2000);
  await page.click('.tune');
  await advance('tune sheet open', 1000);
  await page.click('.sound');
  await advance('sound off', 1000);
  const ui = await page.evaluate(() => ({
    presets: [...document.querySelectorAll('[data-preset]')].map((b) => b.textContent + (b.classList.contains('on') ? '*' : '')).join(' '),
    sheetOpen: document.querySelector('.ui').classList.contains('open'),
    hs: document.querySelector('[data-out="waveScale"]').textContent,
    wind: document.querySelector('[data-out="wind"]').textContent,
    size: [app.w, app.h, app.scale.toFixed(2)],
    format: app.ms.format,
  }));
  console.log(JSON.stringify({ checks, audio, ui, errors }, null, 1));
} finally {
  await browser.close();
}
