// The 60-second film: deterministic weather + camera timelines (keyframes, smooth interpolation),
// in three acts. I: golden-hour calm. II: a squall line crosses the sea towards the camera, the
// sunlit foreground against a black wall of cloud and rain, then gale, downpour and lightning.
// III: night after the storm, a moonlit swell, the storm bank flickering silently on the horizon.

const smooth = (t) => t * t * (3 - 2 * t);

const ACT1 = {
  start: 0, end: 17,
  weather: [
    [0, { wind: 3.0, windDir: 20, clouds: 0.22, cloudDark: 0, cloudBase: 1500, rain: 0, mist: 0, haze: 1.4, choppy: 0.75, waveScale: 1, swellHs: 1.0, swellDir: 40, sunElev: 5, sunAz: 205, lightning: 0, fetch: 400, front: 0 }],
    [17, { wind: 6.0, clouds: 0.3, haze: 1.5, choppy: 0.85, swellHs: 1.15, sunElev: 4.5, fetch: 700 }],
  ],
  camera: [
    [0, { yaw: 197, pitch: 1.4, eye: 2.4, fov: 40 }],
    [17, { yaw: 187, pitch: 0.8, eye: 2.8, fov: 42 }],
  ],
};

const ACT2 = {
  start: 17, end: 48,
  weather: [
    [17, { wind: 9, windDir: 230, clouds: 0.42, cloudDark: 0.05, cloudBase: 950, rain: 0, mist: 0, haze: 2, choppy: 0.9, waveScale: 1, swellHs: 1.4, swellDir: 215, sunElev: 30, sunAz: 228, lightning: 0, fetch: 900,
      front: 1, frontDist: 26000, frontAz: 52, frontWidth: 2600, sClouds: 0.97, sDark: 0.9, sBase: 650, sRain: 0.6, sMist: 0.15 }],
    [26, { wind: 12, frontDist: 12500, haze: 2.4, choppy: 0.95, swellHs: 1.7 }],
    [33, { wind: 17, frontDist: 2500, haze: 2.8, choppy: 1.0, swellHs: 2.2, fetch: 1500 }],
    [40, { wind: 22, frontDist: -4000, haze: 3, choppy: 1.05, swellHs: 2.8 }],
    [48, { wind: 23.5, frontDist: -6000, haze: 3, choppy: 1.05, swellHs: 3.0 }],
  ],
  camera: [
    [17, { yaw: 62, pitch: 3.2, eye: 2.6, fov: 46 }],
    [30, { yaw: 50, pitch: 5.0, eye: 3.0, fov: 52 }],
    [40, { yaw: 38, pitch: 7.0, eye: 3.4, fov: 56 }],
    [48, { yaw: 32, pitch: 6.0, eye: 3.6, fov: 58 }],
  ],
};

const ACT3 = {
  start: 48, end: 60,
  weather: [
    [48, { wind: 5.5, windDir: 230, clouds: 0.2, cloudDark: 0, cloudBase: 1400, rain: 0, mist: 0, haze: 1.6, choppy: 0.8, waveScale: 1, swellHs: 2.4, swellDir: 225, sunElev: -14, sunAz: 30, lightning: 0, fetch: 600,
      front: 1, frontDist: 26000, frontAz: 245, frontWidth: 3000, sClouds: 0.95, sDark: 0.85, sBase: 700, sRain: 0.6, sMist: 0.15 }],
    [60, { wind: 4.5, swellHs: 2.2, frontDist: 27500 }],
  ],
  camera: [
    [48, { yaw: 222, pitch: 2.6, eye: 2.6, fov: 48 }],
    [60, { yaw: 230, pitch: 2.2, eye: 2.4, fov: 46 }],
  ],
};

// scripted strikes: time (s), distance (m), bearing relative to the camera (rad).
// Thunder arrives dist / 343 m/s later: the early, distant strikes are seen long before heard.
export const STRIKES = [
  { t: 24.5, dist: 10500, rel: 0.12, ground: true, power: 0.9 },
  { t: 28.6, dist: 6200, rel: -0.22, ground: true, power: 1.0 },
  { t: 31.8, dist: 2600, rel: 0.3, ground: false, power: 0.9 },
  { t: 35.4, dist: 1800, rel: -0.1, ground: true, power: 1.1 },
  { t: 39.2, dist: 1150, rel: 0.05, ground: true, power: 1.35 },
  { t: 43.1, dist: 1900, rel: -0.38, ground: false, power: 0.9 },
  { t: 45.6, dist: 750, rel: 0.14, ground: true, power: 1.45 },
  // act III: the departing storm, 27+ km away: flashes in the cloud bank, no audible thunder
  { t: 51.2, dist: 29000, rel: 0.42, ground: false, power: 1.3 },
  { t: 54.0, dist: 31000, rel: 0.5, ground: false, power: 1.1 },
  { t: 55.1, dist: 30000, rel: 0.38, ground: false, power: 1.4 },
  { t: 58.3, dist: 32000, rel: 0.47, ground: false, power: 1.2 },
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

const ACTS = [ACT1, ACT2, ACT3];
const actAt = (t) => { let i = 0; while (i < ACTS.length - 1 && t >= ACTS[i + 1].start) i++; return i; };

export const film = {
  duration: 60,
  acts: ACTS,
  actAt,
  weatherAt: (t) => sample(ACTS[actAt(t)].weather, t),
  cameraAt: (t) => sample(ACTS[actAt(t)].camera, t),
  // dips to black around the cuts, fade in at the start and out at the end
  fadeAt: (t) => {
    let f = Math.min(smooth(Math.min(Math.max(t / 1.2, 0), 1)), smooth(Math.min(Math.max((60 - t) / 1.8, 0), 1)));
    for (const a of ACTS.slice(1)) f = Math.min(f, smooth(Math.min(Math.abs(t - a.start) / 0.45, 1)));
    return f;
  },
  strikes: STRIKES,
};
