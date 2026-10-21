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
  // A: connected lace network for the residual foam of gale-force seas: the borders of bubble
  // rafts form a cellular lattice, i.e. the edges (F2 - F1 = 0) of a domain-warped Voronoi diagram
  vec2 q2 = uv + w * 0.05;
  vec2 c1 = voronoi(q2 * 7.0, 7.0);
  vec2 c2 = voronoi(q2 * 17.0 + 3.1, 17.0);
  float net = min((c1.y - c1.x) * 1.7, (c2.y - c2.x) * 2.4 + 0.14);
  o = vec4(T, bub, S, clamp(net, 0.0, 1.0));
}`;

export class FoamTexture {
  constructor(gl, size = 1024) {
    this.tex = new Texture(gl, { w: size, h: size, format: 'rgba8', wrap: 'repeat', mips: true, aniso: 8 });
    const prog = new Program(gl, FULLSCREEN_VS, GEN_FS, { label: 'foamgen' });
    fullscreen(gl, prog, {}, new Target(gl, [this.tex]));
    this.tex.genMips();
  }
}

// Returns vec2(coverage, thickness). f = accumulated whitecap foam density, lace = residual
// stage-B foam network (gale force) drawn as thin lines along the wind.
export const FOAM_GLSL = `
uniform sampler2D uFoamTex;
uniform vec2 uWindDir;
uniform float uFoamStretch;   // 0: isotropic patches, 1: fully streaky (gale)
vec2 foamBump = vec2(0.0);
vec2 foamCoverage(vec2 xz, float f, float lace, float dist) {
  vec2 w = uWindDir;
  vec2 p = vec2(dot(xz, w), dot(xz, vec2(-w.y, w.x)));
  // derivatives first: they must be evaluated in uniform control flow
  vec2 dpx = dFdx(p), dpy = dFdy(p);
  vec4 a = texture(uFoamTex, p / 5.5);
  vec4 b = texture(uFoamTex, p / 1.9 + vec2(0.37, 0.71));
  vec4 s = texture(uFoamTex, vec2(p.x / 45.0, p.y / 15.0) + vec2(0.13, 0.5));
  // large-scale structure stretches along the wind as it strengthens (wind rows of foam)
  vec4 big = texture(uFoamTex, vec2(p.x / (37.0 * (1.0 + 1.2 * uFoamStretch)), p.y / 37.0) + vec2(0.61, 0.27));
  // multi-scale threshold: the large component makes patch outlines ragged at metre scale
  float T = big.r * 0.4 + a.r * 0.38 + b.r * 0.22;
  T = mix(T, mix(T, s.b * 0.8 + big.g * 0.25, 0.45), uFoamStretch);
  vec2 dT = vec2(dFdx(T), dFdy(T));
  float fwT = abs(dT.x) + abs(dT.y);
  vec2 pl = vec2(p.x / (1.0 + 2.2 * uFoamStretch), p.y);
  float va = texture(uFoamTex, pl / 4.2 + vec2(0.21, 0.83)).a;
  float vb = texture(uFoamTex, pl / 1.5 + vec2(0.57, 0.11)).a;
  float vein = va * 0.6 + vb * 0.4;
  float fwV = fwidth(vein);
  if (f < 0.003 && lace < 0.003) return vec2(0.0);
  float F = (1.0 - exp(-f * 1.5)) * 0.92;
  // fresh foam is a dense mass; decaying foam opens up along the threshold field.
  // Bubble noise dithers the boundary so it reads as a froth edge, not a painted outline.
  float margin = F * 1.15 - T + (b.g - 0.5) * 0.16 * min(F * 4.0, 1.0);
  float edge = 0.09 + fwT * 0.7;
  // gated by density: a trace of foam must not light up the threshold field's thin veins
  float cov = clamp(margin / edge, 0.0, 1.0) * smoothstep(0.015, 0.1, F);
  // far away: sub-pixel structure averages out to the expected (energy-conserving) coverage
  vec2 g = max(abs(dpx), abs(dpy)) / 5.5 * 1024.0;
  float far = smoothstep(2.5, 6.5, log2(max(max(g.x, g.y), 1e-3)));
  cov = mix(cov, clamp(F * 1.25, 0.0, 1.0), far);
  // residual lace: thin vein lines, stretched along the wind, thicker as the gale strengthens
  float lc = 0.0;
  if (lace > 0.003) {
    // lace persists where whitecaps broke recently (old foam f) and in wind-row patches (big.b)
    float rafts = smoothstep(0.22, 0.6, big.b * 0.7 + clamp(f * 3.0, 0.0, 1.0) * 0.6);
    float wid = (0.04 + lace * 0.16) * (0.5 + rafts) + fwV * 0.6;
    lc = (1.0 - smoothstep(wid * 0.4, wid, vein)) * smoothstep(0.0, 0.08, lace) * rafts;
    lc = mix(lc, lace * 0.3 * rafts, far);
  }
  float bub = mix(a.g * 0.45 + b.g * 0.35 + big.r * 0.2, 0.8, far);
  // optical thickness: dense where the foam far exceeds its threshold, thin near its edges
  float thick = mix(smoothstep(0.0, 0.45, margin), clamp(F * 1.4, 0.0, 1.0), far) * bub;
  // churned texture inside dense whitecaps: never a flat sheet of white
  cov *= mix(0.78 + 0.22 * smoothstep(0.2, 0.8, b.g * 0.6 + a.g * 0.4), 1.0, far);
  // relief of the bubble mass: world-space slope of the structure field (treated as ~15 cm of height),
  // recovered from screen derivatives, for side-lit shading of the foam
  mat2 Mj = mat2(dpx.x, dpy.x, dpx.y, dpy.y);
  float det = determinant(Mj);
  vec2 grad = abs(det) > 1e-12 ? inverse(Mj) * dT : vec2(0.0);
  grad = clamp(grad * 0.15, vec2(-1.5), vec2(1.5)) * (1.0 - far);
  foamBump = grad.x * w + grad.y * vec2(-w.y, w.x);
  // lace is a thin translucent bubble film
  thick = max(thick, lc * 0.7);
  return vec2(max(cov, lc), thick);
}
`;
