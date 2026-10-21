// Ocean statistics for presets: node tools/stats.mjs "preset=storm&rain=0" "preset=breeze&wind=15" ...
import { launch, openApp } from './browser.mjs';

const browser = await launch({ width: 320, height: 180 });
try {
  for (const q of process.argv.slice(2)) {
    const page = await openApp(browser, `http://localhost:5173/?render&${q}`, { width: 320, height: 180 });
    const s = await page.evaluate(() => {
      for (let i = 0; i < 30; i++) app.frame(1 / 30);
      const st = app.ocean.stats;
      return { hs: st.hs, mss: st.resolvedMss, coxMunk: st.coxMunk, bands: st.bandMss, lambda: app.ocean.lambda, wind: app.weather.state.wind, fetch: app.weather.state.fetch };
    });
    console.log(q.padEnd(40), JSON.stringify(s, (k, v) => (typeof v === 'number' ? +v.toPrecision(3) : v)));
    await page.close();
  }
} finally {
  await browser.close();
}
