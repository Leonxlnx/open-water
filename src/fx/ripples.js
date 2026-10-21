// Raindrop impact ring waves on the sea surface (procedural, analytic slopes).
// Capillary ring packets expand at ~0.23 m/s (minimum phase speed of capillary-gravity waves)
// and die out within a second. Far away the rings are sub-pixel: their energy becomes roughness.
export const RAIN_SURFACE_GLSL = `
vec3 rhash3(vec2 p) {
  vec3 q = vec3(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9)));
  return fract(sin(q) * 43758.5453);
}
vec2 rippleLayer(vec2 xz, float t, float cell, float life, float rain, float seed) {
  vec2 p = xz / cell + seed;
  vec2 base = floor(p) - 1.0;
  vec2 slope = vec2(0.0);
  for (int j = 0; j <= 2; j++) for (int i = 0; i <= 2; i++) {
    vec2 cid = base + vec2(float(i), float(j));
    vec3 h = rhash3(cid + seed * 7.13);
    float period = life * (1.0 + h.z);
    float tt = t / period + h.x * 13.7;
    float cycle = floor(tt);
    float tl = fract(tt) * period;                // seconds since impact
    vec3 h2 = rhash3(cid + cycle * 0.618 + seed);
    if (h2.z > rain) continue;                    // inactive this cycle
    vec2 c = (cid + 0.2 + 0.6 * h2.xy - seed) * cell;
    vec2 d = xz - c;
    float r = length(d);
    float R = 0.012 + 0.24 * tl;
    float w = 0.012 + 0.03 * tl;
    float x = (r - R) / w;
    if (abs(x) > 3.0) continue;
    float lambda = 0.016 + 0.01 * tl;
    float env = exp(-x * x) * exp(-tl * 2.5) * mix(0.3, 1.0, h2.x * h2.x);
    env *= (1.0 - smoothstep(0.9 * cell, 1.2 * cell, r)) * (1.0 - smoothstep(0.7 * period, period, tl));
    float ds = env * cos(6.2831 * (r - R) / lambda) * (0.22 + 0.16 * h.y);
    slope += ds * d / max(r, 1e-4);
  }
  return slope;
}
// Impact craters: a dimple ~1 cm wide at every drop impact, relaxing within ~60 ms. One jittered
// impact per cell and cycle (radius << cell: no neighbour search).
vec2 craterLayer(vec2 xz, float t, float cell, float life, float rain, float seed) {
  vec2 p = xz / cell + seed;
  vec2 id = floor(p);
  vec3 h = rhash3(id + seed * 3.1);
  float period = life * (1.0 + h.z);
  float tt = t / period + h.x * 11.3;
  float tl = fract(tt) * period;
  vec3 h2 = rhash3(id + floor(tt) * 0.731 + seed);
  if (h2.z > rain) return vec2(0.0);
  vec2 d = (p - id - (0.15 + 0.7 * h2.xy)) * cell;
  float sig = 0.004 + 0.006 * h.y * h.y;
  float A = 1.1 * exp(-tl / 0.06);
  return A * 2.0 * d / sig * exp(-dot(d, d) / (sig * sig));
}
// pix: pixel footprint (m). Rings (1.6-2.6 cm wavelength) and craters (~1 cm) are drawn only while
// they are resolved; beyond that their energy is roughness (and the stipple in the water shader).
vec3 rainRipples(vec2 xz, float t, float rain, float dist, float pix) {
  if (rain < 0.002) return vec3(0.0);
  float near = 1.0 - smoothstep(0.005, 0.011, pix);
  vec2 s = vec2(0.0);
  if (near > 0.0) {
    float density = clamp(rain * 1.4, 0.0, 1.0);
    s += rippleLayer(xz, t, 0.21, 0.55, density, 0.0);
    s += rippleLayer(xz, t + 0.31, 0.17, 0.5, density * 0.9, 3.7);
    s += rippleLayer(xz, t + 0.73, 0.27, 0.65, density * 0.8, 9.1);
    s += rippleLayer(xz, t + 0.17, 0.1, 0.45, density * 0.85, 13.3);
    s += rippleLayer(xz, t + 0.49, 0.12, 0.5, density * 0.85, 17.9);
    s *= near;
    // ~2600 impacts per m2 and second at the heaviest rate; resolved only within a few metres
    float cr = 1.0 - smoothstep(0.003, 0.006, pix);
    if (cr > 0.0) {
      // two layers on rotated, differently sized grids: no visible lattice
      const mat2 R1 = mat2(0.934, 0.358, -0.358, 0.934), R2 = mat2(0.799, -0.602, 0.602, 0.799);
      s += (R1 * craterLayer(transpose(R1) * xz, t, 0.043, 0.25, density * 0.8, 1.3)
          + R2 * craterLayer(transpose(R2) * xz, t + 0.11, 0.061, 0.3, density * 0.8, 5.9)) * cr;
    }
  }
  // sub-pixel ring energy -> isotropic roughness (per-axis slope variance)
  float rough = rain * 0.006 * (1.0 - near * 0.6);
  return vec3(s, rough);
}
`;
