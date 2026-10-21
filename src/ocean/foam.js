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
float foamCovA = 0.0;   // stage-A (actively breaking) coverage of the last call, for calibration
vec2 foamCoverage(vec2 xz, float f, float lace, float act, float dist) {
  vec2 w = uWindDir;
  vec2 p = vec2(dot(xz, w), dot(xz, vec2(-w.y, w.x)));
  // derivatives first: they must be evaluated in uniform control flow
  vec2 dpx = dFdx(p), dpy = dFdy(p);
  vec4 a = texture(uFoamTex, p / 5.5);
  vec4 b = texture(uFoamTex, p / 1.9 + vec2(0.37, 0.71));
  vec4 s = texture(uFoamTex, vec2(p.x / 45.0, p.y / 15.0) + vec2(0.13, 0.5));
  // large-scale structure stretches along the wind as it strengthens (wind rows of foam)
  vec4 big = texture(uFoamTex, vec2(p.x / (37.0 * (1.0 + 5.0 * uFoamStretch)), p.y / 37.0) + vec2(0.61, 0.27));
  // a crest breaks in segments of a few metres, not along its whole length
  float seg = texture(uFoamTex, vec2(p.x / 6.0, p.y / 8.0) + vec2(0.43, 0.19)).r;
  // wind rows: bands ~60 m long and a few metres wide along the wind (Langmuir convergence lines)
  float wr = texture(uFoamTex, vec2(p.x / 140.0, p.y / 24.0 + (big.g - 0.5) * 0.15) + vec2(0.71, 0.37)).b;
  // multi-scale threshold: the large component makes patch outlines ragged at metre scale
  // filament-scale threshold: foam structure lives at 0.3-2 m; the 37 m field only modulates
  float T = big.r * 0.18 + a.r * 0.42 + b.r * 0.4;
  T = mix(T, mix(T, s.b * 0.8 + big.g * 0.25, 0.45), uFoamStretch);
  vec2 dT = vec2(dFdx(T), dFdy(T));
  float fwT = abs(dT.x) + abs(dT.y);
  // footprint of a pixel in metres (geometric mean of the axes: what anisotropic filtering resolves)
  float fpm = sqrt(length(dpx) * length(dpy));
  vec2 pl = vec2(p.x / (1.0 + 9.0 * uFoamStretch), p.y) + (vec2(a.r, b.r) - 0.5) * 0.6;
  float va = texture(uFoamTex, pl / 4.2 + vec2(0.21, 0.83)).a;
  float vb = texture(uFoamTex, pl / 1.5 + vec2(0.57, 0.11)).a;
  float vein = va * 0.6 + vb * 0.4 * (1.0 - smoothstep(0.08, 0.3, fpm)) + 0.2 * smoothstep(0.08, 0.3, fpm);
  float fwV = fwidth(vein);
  if (f < 0.003 && lace < 0.003 && act < 0.003) return vec2(0.0);
  // densities in [0, 1): residual (stage B, seconds to tens of seconds) and active breaking (stage A)
  float F = 1.0 - exp(-f * 1.3);
  float A = min((1.0 - exp(-act * 2.0)) * mix(0.5, 1.0, smoothstep(0.25, 0.6, seg)) * 1.2, 1.0);
  // coverage = P(pattern < density): foam fills the low values of a pattern field first.
  //  Pa, active froth: metre-scale churn plus the raft network, so the rim of a breaking crest
  //      frays into filaments and specks, and only the core is solid (with holes)
  //  Pr, residual foam: the raft network dominates, so decaying foam opens up into lace and marbling
  // (cap cores are solid; only the rims fray along the raft network)
  float Pa = clamp(T * 0.8 + vein * 0.35 * (1.0 - smoothstep(0.5, 0.9, A)) - 0.12, 0.0, 1.0);
  float Pr = clamp(vein * 0.85 + T * 0.3 - 0.1, 0.0, 1.0);
  float far = smoothstep(0.4, 1.6, fpm);
  // crisp froth edges near, softening only as the structure becomes sub-pixel
  float edge = 0.035 + fwT * 0.6 + fwV * 0.4 + far * 0.2;
  // residual foam gathers into wind rows (streaks along the wind) as the gale strengthens
  // (ragged edges: the metre-scale structure frays the rows)
  float wrr = wr + (a.r - 0.5) * 0.22 + (b.r - 0.5) * 0.12;
  float Fs = F * mix(1.0, 0.25 + 1.6 * pow(smoothstep(0.2, 0.7, wrr), 2.0), uFoamStretch);
  // a bubble raft never fills its cells: the centres stay open, so old foam stays a network
  // (very dense old foam, as in a gale, does fill most of its cells)
  float mA = A * 1.08 - Pa, mR = Fs * mix(0.62, 0.9, smoothstep(0.5, 0.95, F)) - Pr;
  float covA = smoothstep(-edge, edge, mA) * smoothstep(0.08, 0.22, A);
  // residual foam is a thinner bubble raft: translucent, the water shows through
  // ... and thins as it ages: old foam is a translucent film that takes the water's tint
  // (below a minimum density old foam is an invisible film: no isolated specks on pattern minima)
  float eR = max(edge, 0.08);
  float covR = smoothstep(-eR, eR, mR) * mix(0.45, 0.92, smoothstep(0.15, 0.7, F));
  covR *= smoothstep(0.15, 0.35, Fs);
  // where the raft network is unresolved, its mean coverage
  covR = mix(covR, clamp(Fs * 0.25, 0.0, 1.0) * 0.85 * smoothstep(0.15, 0.35, Fs), smoothstep(0.12, 0.3, 0.85 * fwV + 0.3 * fwT));
  // far away the structure is sub-pixel: the expected coverage (energy conserving)
  covA = mix(covA, clamp(A * 0.95, 0.0, 1.0), far);
  covR = mix(covR, clamp(Fs * 0.4, 0.0, 1.0) * 0.85 * smoothstep(0.15, 0.35, Fs), far);
  float cov = max(covA, covR);
  foamCovA = covA;
  // residual lace: thin vein lines, stretched along the wind, thicker as the gale strengthens
  float lc = 0.0;
  if (lace > 0.003) {
    // lace persists where whitecaps broke recently (old foam f) and in wind-row patches (big.b)
    // lace persists only where foam actually was (old foam f), patchy at the wind-row scale
    float rafts = smoothstep(0.01, 0.15, f) * smoothstep(0.15, 0.6, big.b);
    float wid = (0.05 + lace * 0.18) * (0.6 + rafts);
    // a translucent bubble film, not opaque paint; once the lines are thinner than ~2.5 px they
    // fade to their mean coverage instead of breaking into hairline confetti
    float lcMean = lace * 0.08 * rafts;
    lc = (1.0 - smoothstep(wid * 0.1, wid * 1.4, vein)) * smoothstep(0.0, 0.08, lace) * rafts * 0.35;
    lc = mix(lcMean, lc, smoothstep(1.5, 3.0, wid / max(fwV, 1e-4)) * (1.0 - far));
  }
  float bub = mix(a.g * 0.45 + b.g * 0.35 + big.r * 0.2, 0.8, far);
  // optical thickness: dense where the foam far exceeds its threshold, thin near its edges
  float thick = mix(max(smoothstep(0.0, 0.3, mA), smoothstep(0.0, 0.3, mR) * 0.6), clamp(max(A, Fs * 0.45) * 1.3, 0.0, 1.0), far) * bub;
  // churned texture inside dense whitecaps: brightness varies with bubble size, coverage stays solid
  thick *= mix(0.6 + 0.4 * smoothstep(0.2, 0.8, b.g * 0.6 + a.g * 0.4), 1.0, far);
  // relief of the bubble mass: world-space slope of the structure field (treated as ~15 cm of height),
  // recovered from screen derivatives, for side-lit shading of the foam
  mat2 Mj = mat2(dpx.x, dpy.x, dpx.y, dpy.y);
  float det = determinant(Mj);
  vec2 grad = abs(det) > 1e-12 ? inverse(Mj) * dT : vec2(0.0);
  grad = clamp(grad * 0.4, vec2(-1.5), vec2(1.5)) * (1.0 - far);
  foamBump = grad.x * w + grad.y * vec2(-w.y, w.x);
  // caps fade as they age downwind; lace is a thin translucent bubble film
  thick *= mix(0.85, 1.0, A / (A + F + 1e-3));
  // fresh caps have an opaque white core; dense old foam stays a solid raft
  thick = max(thick, covA * smoothstep(0.25, 0.6, A) * mix(0.7, 0.92, b.g));
  thick = max(thick, smoothstep(0.4, 0.85, Fs) * smoothstep(0.0, 0.2, mR) * 0.5);
  thick = max(thick, lc * 0.5);
  return vec2(max(cov, lc), thick);
}
`;
