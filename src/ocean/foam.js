// Procedural, tileable foam structure (no image assets).
// R: marbling threshold (ridged multi-scale noise): residual foam survives longest along the
//    veins, so decaying whitecaps turn into the lacy, marbled networks seen on real seas.
// G: fine bubble texture.  B: wind streak field (stretched along +x = downwind).
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';

const GEN_FS = `
in vec2 vUv;
out vec4 o;
float hash1(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 45758.5453); }
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
// periodic gradient noise in [-1, 1]
float gnoise(vec2 x, vec2 P) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash2(mod(i, P)) * 2.0 - 1.0, f);
  float b = dot(hash2(mod(i + vec2(1, 0), P)) * 2.0 - 1.0, f - vec2(1, 0));
  float c = dot(hash2(mod(i + vec2(0, 1), P)) * 2.0 - 1.0, f - vec2(0, 1));
  float d = dot(hash2(mod(i + vec2(1, 1), P)) * 2.0 - 1.0, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
}
float fbm(vec2 x, vec2 P, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 7; i++) { if (i >= oct) break; s += a * gnoise(x, P); n += a; x *= 2.0; P *= 2.0; a *= 0.5; }
  return s / n;
}
float ridged(vec2 x, vec2 P, int oct) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++) { if (i >= oct) break; s += a * abs(gnoise(x, P)); n += a; x *= 2.0; P *= 2.0; a *= 0.55; }
  return s / n;
}
vec2 voronoi(vec2 x, float P) {
  vec2 n = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 r = g + hash2(mod(n + g, P)) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return sqrt(vec2(d1, d2));
}
void main() {
  vec2 uv = vUv;
  // domain-warped ridged noise: veins (low values) where foam lingers
  vec2 w = vec2(fbm(uv * 3.0, vec2(3.0), 4), fbm(uv * 3.0 + 7.7, vec2(3.0), 4));
  vec2 q = uv + w * 0.08;
  float vein = ridged(q * 5.0, vec2(5.0), 5);              // 0 on veins
  float blob = fbm(q * 4.0 + 1.3, vec2(4.0), 5) * 0.5 + 0.5;
  float T = clamp(vein * 1.35 * 0.6 + blob * 0.55 - 0.08, 0.0, 1.0);
  // bubbles: small cells with bright rims
  vec2 v = voronoi(uv * 90.0, 90.0);
  float bub = 0.55 + 0.45 * smoothstep(0.0, 0.35, v.y - v.x);
  bub *= 0.85 + 0.15 * (fbm(uv * 40.0, vec2(40.0), 3) * 0.5 + 0.5);
  // streaks: anisotropic noise, 1:8 along x
  vec2 s = vec2(uv.x * 2.0, uv.y * 16.0);
  float streak = fbm(s, vec2(2.0, 16.0), 5) * 0.5 + 0.5;
  float sr = ridged(vec2(uv.x * 3.0, uv.y * 24.0) + w * 0.5, vec2(3.0, 24.0), 4);
  float S = clamp(0.55 * streak + 0.6 * sr, 0.0, 1.0);
  o = vec4(T, bub, S, 1.0);
}`;

export class FoamTexture {
  constructor(gl, size = 1024) {
    this.tex = new Texture(gl, { w: size, h: size, format: 'rgba8', wrap: 'repeat', mips: true, aniso: 8 });
    const prog = new Program(gl, FULLSCREEN_VS, GEN_FS, { label: 'foamgen' });
    fullscreen(gl, prog, {}, new Target(gl, [this.tex]));
    this.tex.genMips();
  }
}

// Returns vec2(coverage, thickness). f = accumulated foam density.
export const FOAM_GLSL = `
uniform sampler2D uFoamTex;
uniform vec2 uWindDir;
uniform float uFoamStretch;   // 0: isotropic patches, 1: fully streaky (gale)
vec2 foamCoverage(vec2 xz, float f, float t, float dist) {
  if (f < 0.003) return vec2(0.0);
  vec2 w = uWindDir;
  vec2 p = vec2(dot(xz, w), dot(xz, vec2(-w.y, w.x)));
  vec4 a = texture(uFoamTex, p / 5.5);
  vec4 b = texture(uFoamTex, p / 1.9 + vec2(0.37, 0.71));
  vec4 s = texture(uFoamTex, vec2(p.x / 45.0, p.y / 15.0) + vec2(0.13, 0.5));
  vec4 big = texture(uFoamTex, p / 37.0 + vec2(0.61, 0.27));
  // multi-scale threshold: the large component makes patch outlines ragged at metre scale
  float T = big.r * 0.4 + a.r * 0.38 + b.r * 0.22;
  T = mix(T, mix(T, s.b * 0.8 + big.g * 0.25, 0.6), uFoamStretch);
  float F = (1.0 - exp(-f * 1.5)) * 0.92;
  // fresh foam is a solid sheet; decaying foam opens up along the threshold field
  float edge = 0.07 + fwidth(T) * 0.7;
  float cov = clamp((F * 1.15 - T) / edge + 0.1, 0.0, 1.0);
  // far away: sub-pixel structure averages out to the expected (energy-conserving) coverage
  vec2 g = max(abs(dFdx(p)), abs(dFdy(p))) / 5.5 * 1024.0;
  float far = smoothstep(2.5, 6.5, log2(max(max(g.x, g.y), 1e-3)));
  cov = mix(cov, clamp(F * 1.25, 0.0, 1.0), far);
  float bub = mix(a.g * 0.45 + b.g * 0.35 + big.r * 0.2, 0.8, far);
  float thick = clamp(F * 1.4, 0.0, 1.0) * bub;
  return vec2(cov, thick);
}
`;
