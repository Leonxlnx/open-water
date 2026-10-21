// Foam calibration: measures visible foam coverage vs wind speed (compare: Monahan 1980 W = 3.84e-6 U^3.41)
import { launch, openApp } from './browser.mjs';
const winds = (process.argv[2] || '5,8.5,11,15,21').split(',').map(Number);
const browser = await launch({ width: 800, height: 800 });
try {
  for (const U of winds) {
    const page = await openApp(browser, `http://localhost:5173/?render&preset=breeze&wind=${U}&clouds=0`, { width: 800, height: 800 });
    const r = await page.evaluate(() => {
      for (let i = 0; i < 1800; i++) app.frame(1 / 30);  // 60 s: residual foam (e-fold up to ~20 s) at steady state
      return app.measureFoam();
    });
    const monahan = 3.84e-6 * Math.pow(U, 3.41);
    console.log(`U=${U} m/s  visible=${(r.coverage * 100).toFixed(2)}%  raw=${r.raw.toFixed(3)}  monahan=${(monahan * 100).toFixed(2)}%`);
    await page.close();
  }
} finally { await browser.close(); }
