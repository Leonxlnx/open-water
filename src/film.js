// The 60-second film: deterministic weather + camera timelines (keyframes, smooth interpolation),
// in two acts. I: golden-hour calm. II: a squall line crosses the sea towards the camera, the sunlit
// foreground against a black wall of cloud and rain, then gale, downpour and lightning.

const smooth = (t) => t * t * (3 - 2 * t);

const ACT1 = {
  start: 0, end: 21,
  weather: [
    [0, { wind: 3.0, windDir: 20, clouds: 0.22, cloudDark: 0, cloudBase: 1500, rain: 0, mist: 0, haze: 1.4, choppy: 0.75, waveScale: 1, swellHs: 1.0, swellDir: 40, sunElev: 5, sunAz: 205, lightning: 0, fetch: 400, front: 0 }],
    [21, { wind: 6.5, clouds: 0.3, haze: 1.5, choppy: 0.85, swellHs: 1.15, sunElev: 4.4, fetch: 700 }],
  ],
  camera: [
    [0, { yaw: 197, pitch: 1.4, eye: 2.4, fov: 40 }],
    [21, { yaw: 186, pitch: 0.8, eye: 2.8, fov: 42 }],
  ],
};

const ACT2 = {
  start: 21, end: 60,
  weather: [
    [21, { wind: 9, windDir: 230, clouds: 0.42, cloudDark: 0.05, cloudBase: 1300, rain: 0, mist: 0, haze: 2, choppy: 0.9, waveScale: 1, swellHs: 1.4, swellDir: 215, sunElev: 30, sunAz: 228, lightning: 0, fetch: 900,
      front: 1, frontDist: 17000, frontAz: 52, frontWidth: 2600, sClouds: 0.97, sDark: 0.9, sBase: 600, sRain: 1, sMist: 0.35 }],
    [32, { wind: 12, frontDist: 7500, haze: 2.5, choppy: 0.95, swellHs: 1.7 }],
    [40, { wind: 17, frontDist: 0, haze: 3.5, choppy: 1.0, swellHs: 2.2, fetch: 1500 }],
    [47, { wind: 22, frontDist: -4000, haze: 4.5, choppy: 1.05, swellHs: 2.8 }],
    [60, { wind: 23.5, frontDist: -6500, haze: 5, choppy: 1.05, swellHs: 3.0 }],
  ],
  camera: [
    [21, { yaw: 62, pitch: 3.2, eye: 2.6, fov: 46 }],
    [36, { yaw: 50, pitch: 4.0, eye: 3.0, fov: 50 }],
    [48, { yaw: 38, pitch: 3.0, eye: 3.4, fov: 52 }],
    [60, { yaw: 30, pitch: 3.0, eye: 3.6, fov: 54 }],
  ],
};

// scripted strikes in the storm: time (s), distance (m), bearing relative to the camera (rad).
// Thunder arrives dist / 343 m/s later: the early, distant strikes are seen long before heard.
export const STRIKES = [
  { t: 29.0, dist: 12500, rel: 0.12, ground: true, power: 0.9 },
  { t: 34.2, dist: 7200, rel: -0.22, ground: true, power: 1.0 },
  { t: 38.6, dist: 4000, rel: 0.3, ground: false, power: 0.9 },
  { t: 43.0, dist: 2100, rel: -0.1, ground: true, power: 1.1 },
  { t: 47.2, dist: 1250, rel: 0.05, ground: true, power: 1.35 },
  { t: 51.6, dist: 2600, rel: -0.38, ground: false, power: 0.9 },
  { t: 55.4, dist: 800, rel: 0.14, ground: true, power: 1.45 },
];

function sample(keys, t) {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= t) i++;
  const at = (idx) => { const o = {}; for (let j = 0; j <= idx; j++) Object.assign(o, keys[j][1]); return o; };
  const A = at(i), B = at(Math.min(i + 1, keys.length - 1));
  const t0 = keys[i][0], t1 = keys[Math.min(i + 1, keys.length - 1)][0];
  const f = t1 > t0 ? smooth(Math.min(Math.max((t - t0) / (t1 - t0), 0), 1)) : 0;
  const out = {};
  for (const k in A) out[k] = A[k] + ((B[k] ?? A[k]) - A[k]) * f;
  return out;
}

const ACTS = [ACT1, ACT2];
const actAt = (t) => (t < ACT2.start ? 0 : 1);

export const film = {
  duration: 60,
  acts: ACTS,
  actAt,
  weatherAt: (t) => sample(ACTS[actAt(t)].weather, t),
  cameraAt: (t) => sample(ACTS[actAt(t)].camera, t),
  // dip to black around the cut
  fadeAt: (t) => {
    const d = Math.abs(t - ACT2.start);
    const fin = Math.min(t / 1.2, 1), fout = Math.min((60 - t) / 1.5, 1);
    return Math.min(smooth(Math.min(d / 0.4, 1)), smooth(Math.max(fin, 0)), smooth(Math.max(fout, 0)));
  },
  strikes: STRIKES,
};
