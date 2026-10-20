// Weather state: presets, smooth transitions and derived physical parameters.
import { lerp, clamp, smoothstep } from './math.js';

export const PRESETS = {
  calm: {
    wind: 3.2, windDir: 20, fetch: 150, waveScale: 1, choppy: 0.75,
    swellHs: 0.7, swellT: 10, swellDir: 40, swellSpread: 24,
    clouds: 0.18, cloudDark: 0, cloudBase: 1400, rain: 0, lightning: 0, haze: 1.0, mist: 0,
  },
  breeze: {
    wind: 8.5, windDir: 20, fetch: 900, waveScale: 1, choppy: 0.9,
    swellHs: 1.1, swellT: 11, swellDir: 45, swellSpread: 20,
    clouds: 0.38, cloudDark: 0.05, cloudBase: 1200, rain: 0, lightning: 0, haze: 1.3, mist: 0,
  },
  rain: {
    wind: 11, windDir: 25, fetch: 900, waveScale: 1, choppy: 0.95,
    swellHs: 1.3, swellT: 11, swellDir: 50, swellSpread: 18,
    clouds: 0.92, cloudDark: 0.45, cloudBase: 900, rain: 0.6, lightning: 0.0, haze: 4, mist: 0.35,
  },
  storm: {
    wind: 21, windDir: 30, fetch: 1500, waveScale: 1, choppy: 1.0,
    swellHs: 2.6, swellT: 13, swellDir: 55, swellSpread: 12,
    clouds: 0.95, cloudDark: 0.85, cloudBase: 650, rain: 1.0, lightning: 0.7, haze: 5, mist: 0.25,
  },
};

const KEYS = Object.keys(PRESETS.calm);

// piecewise-linear lookup
function table(x, xs, ys) {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) return lerp(ys[i - 1], ys[i], (x - xs[i - 1]) / (xs[i] - xs[i - 1]));
  return ys[ys.length - 1];
}

export class Weather {
  constructor(preset = 'breeze') {
    this.target = { ...PRESETS[preset] };
    this.state = { ...PRESETS[preset] };
    this.preset = preset;
    this.time = { sunElev: 18, sunAz: 200 };
    this.timeTarget = { ...this.time };
    this.transition = 10; // seconds to settle (time constant ~ transition / 4)
  }
  setPreset(name) {
    this.preset = name;
    Object.assign(this.target, PRESETS[name]);
  }
  set(key, value) {
    if (key in this.timeTarget) this.timeTarget[key] = value;
    else this.target[key] = value;
  }
  snap() {
    Object.assign(this.state, this.target);
    Object.assign(this.time, this.timeTarget);
  }
  update(dt) {
    const a = 1 - Math.exp((-dt * 4) / this.transition);
    for (const k of KEYS) this.state[k] = lerp(this.state[k], this.target[k], a);
    const b = 1 - Math.exp(-dt * 2.5);
    for (const k in this.time) this.time[k] = lerp(this.time[k], this.timeTarget[k], b);
  }

  sunDir() {
    const e = (this.time.sunElev * Math.PI) / 180, az = (this.time.sunAz * Math.PI) / 180;
    return [Math.cos(e) * Math.cos(az), Math.sin(e), Math.cos(e) * Math.sin(az)];
  }

  spectrum() {
    const s = this.state;
    const r = (x) => Math.round(x * 1000) / 1000;
    return {
      wind: r(Math.max(s.wind, 0.5)),
      fetch: r(s.fetch * 1000),
      dir: r((s.windDir * Math.PI) / 180),
      scale: r(s.waveScale * s.waveScale),
      swellHs: r(s.swellHs * s.waveScale),
      swellT: r(s.swellT),
      swellDir: r((s.swellDir * Math.PI) / 180),
      swellSpread: r(s.swellSpread),
      spreadBlend: r(smoothstep(14, 26, s.wind) * 0.35),
    };
  }

  foam() {
    const U = this.state.wind;
    // z: breaking threshold in standard deviations of the Jacobian. Calibrated so visible coverage
    // follows ~2x Monahan & O'Muircheartaigh (1980): whitecaps begin ~4 m/s, ~1% at Bf5, ~20% at Bf9.
    const z = table(U, [3, 5, 8.5, 11, 15, 21, 28], [3.2, 2.4, 1.95, 1.75, 1.5, 1.42, 1.05]);
    const gain = 1.2;
    const decay = lerp(0.8, 0.18, smoothstep(5, 24, U)); // residual foam lingers longer in strong wind
    return [z, gain, decay];
  }
}
