// GPU FFT ocean (Tessendorf) with 4 cascades.
// Spectrum: fetch-limited JONSWAP wind sea (Donelan-Banner spreading) + narrow-band swell.
// Each cascade outputs displacement (+ accumulated foam) and slope moments for LEAN-style
// roughness (Bruneton et al. 2010): the slope variance lost by mip filtering becomes BRDF width.
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';
import { rng } from '../math.js';

const N = 256;
export const CASCADES = [
  { L: 1800, },
  { L: 117, },
  { L: 21, },
  { L: 3.7, },
];
const G = 9.81;
const SIGMA_RHO = 7.4e-5; // surface tension / density (m^3/s^2): capillary term of the dispersion

const COMMON = `
const float PI = 3.14159265359;
const float G = 9.81;
const float SIGMA_RHO = ${SIGMA_RHO};
float omegaOf(float k) { return sqrt(G * k + SIGMA_RHO * k * k * k); }
float domegadk(float k) { return (G + 3.0 * SIGMA_RHO * k * k) / (2.0 * omegaOf(k)); }
vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
`;

const SPECTRUM_FS = COMMON + `
uniform sampler2D uNoise;
uniform float uL;
uniform vec2 uBand;        // kmin, kmax for this cascade
uniform vec4 uWind;        // U10 (m/s), fetch (m), direction (rad), amplitude scale
uniform vec4 uSwell;       // Hs (m), peak period (s), direction (rad), spread exponent s
uniform float uShortCut;   // damping length for very short waves
uniform float uSpreadBlend; // a confused storm sea: broad cos^2s spreading blended in
out vec4 o;

// Elfouhaily, Chapron, Katsaros & Vandemark (1997) unified spectrum: JONSWAP-like long waves
// plus a Phillips/Kitaigorodskii short-wave regime calibrated to Cox-Munk slope statistics.
// Returns the omnidirectional wavenumber spectrum S(k) (m^3); kp is the spectral peak.
float elfouhaily(float k, float U, float fetch, out float kp, out float delta) {
  float ko = G / (U * U);
  float X = ko * fetch;
  float Om = clamp(0.84 * pow(tanh(pow(X / 2.2e4, 0.4)), -0.75), 0.84, 5.0);
  kp = ko * Om * Om;
  float cp = sqrt(G / kp);
  const float km = 370.0, cm = 0.23;
  float c = sqrt(G / k * (1.0 + (k / km) * (k / km)));
  float Lpm = exp(-1.25 * (kp / k) * (kp / k));
  float gamma = Om <= 1.0 ? 1.7 : 1.7 + 6.0 * log(Om) / log(10.0);
  float sigma = 0.08 * (1.0 + 4.0 / (Om * Om * Om));
  float r = sqrt(k / kp) - 1.0;
  float Jp = pow(gamma, exp(-r * r / (2.0 * sigma * sigma)));
  float Fp = Lpm * Jp * exp(-Om / sqrt(10.0) * r);
  float Bl = 0.5 * 0.006 * pow(Om, 0.55) * (cp / c) * Fp;
  float ustar = 0.03795 * U; // sqrt(Cd10N = 0.00144) * U10
  // clamped: no capillary-gravity energy below ~2.2 m/s (the fit goes negative there)
  float alpham = max(ustar <= cm ? 0.01 * (1.0 + log(ustar / cm)) : 0.01 * (1.0 + 3.0 * log(ustar / cm)), 0.0);
  float Fm = Lpm * Jp * exp(-0.25 * (k / km - 1.0) * (k / km - 1.0));
  float Bh = 0.5 * alpham * (cm / c) * Fm;
  delta = tanh(0.1733 + 4.0 * pow(c / cp, 2.5) + 0.13 * ustar / cm * pow(cm / c, 2.5));
  return (Bl + Bh) / (k * k * k);
}

float donelanBanner(float theta, float r) {
  r = clamp(r, 0.56, 10.0);
  float beta;
  if (r < 0.95) beta = 2.61 * pow(r, 1.3);
  else if (r < 1.6) beta = 2.28 * pow(r, -1.3);
  else beta = pow(10.0, -0.4 + 0.8393 * exp(-0.567 * log(r * r)));
  float c = cosh(clamp(beta * theta, -15.0, 15.0));
  return beta / (2.0 * tanh(beta * PI)) / (c * c);
}

// Bretschneider/JONSWAP-shaped swell with prescribed Hs, gamma = 5 (narrow).
float swellSpectrum(float w, float Hs, float Tp) {
  float wp = 2.0 * PI / Tp;
  float gamma = 5.0;
  float sigma = w <= wp ? 0.07 : 0.09;
  float d = (w - wp) / (sigma * wp);
  float r = exp(-0.5 * d * d);
  return (5.0 / 16.0) * Hs * Hs * pow(wp, 4.0) / pow(w, 5.0) * exp(-1.25 * pow(wp / w, 4.0))
       * (1.0 - 0.287 * log(gamma)) * pow(gamma, r);
}
float cos2s(float theta, float s) {
  // normalized cos^{2s}(theta/2): Gamma(s+1)/(2 sqrt(pi) Gamma(s+1/2)) ~ sqrt(s + 0.25 + 1/(32 s)) / (2 sqrt(pi))
  float norm = sqrt(s + 0.25 + 1.0 / (32.0 * s)) / (2.0 * sqrt(PI));
  return norm * pow(abs(cos(0.5 * theta)), 2.0 * s);
}

float wrapAngle(float a) { return mod(a + PI, 2.0 * PI) - PI; }

// 2D wavenumber spectrum Psi(kx, kz) (m^4): integral over the k-plane = elevation variance
float spectrum(vec2 k) {
  float kl = length(k);
  if (kl < uBand.x || kl >= uBand.y || kl < 1e-5) return 0.0;
  float th = atan(k.y, k.x);
  float U = max(uWind.x, 0.5);
  float kp, delta;
  float S = elfouhaily(kl, U, uWind.y, kp, delta) * uWind.w;
  float tw = wrapAngle(th - uWind.z);
  // ECKV spreading (1 + delta cos 2phi)/2pi made downwind-dominant; narrow Donelan-Banner near the peak
  const float eps = 0.06;
  float eckv = (1.0 + delta * cos(2.0 * tw)) / (2.0 * PI) * (abs(tw) < 0.5 * PI ? 1.0 : eps) * 2.0 / (1.0 + eps);
  float db = donelanBanner(tw, sqrt(kl / kp));
  float D = mix(db, eckv, smoothstep(1.4, 3.5, kl / kp));
  D = mix(D, cos2s(tw, 2.0), uSpreadBlend);
  float Psi = S / kl * D;
  if (uSwell.x > 0.0) {
    float w = omegaOf(kl);
    float ts = wrapAngle(th - uSwell.z);
    Psi += swellSpectrum(w, uSwell.x, uSwell.y) * cos2s(ts, uSwell.w) * domegadk(kl) / kl;
  }
  return Psi * exp(-kl * kl * uShortCut * uShortCut);
}

void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  float n = float(textureSize(uNoise, 0).x);
  float dk = 2.0 * PI / uL;
  vec2 k = (vec2(id) - n * 0.5) * dk;
  ivec2 mid = (ivec2(n) - id) % ivec2(n);
  if (id.x == 0 || id.y == 0) { o = vec4(0.0); return; } // unpaired Nyquist modes
  vec2 xi = texelFetch(uNoise, id, 0).xy;
  vec2 xm = texelFetch(uNoise, mid, 0).xy;
  // E|h0|^2 = S(k) dk^2 / 2 so that the real field variance equals the spectrum integral.
  float a0 = sqrt(max(spectrum(k), 0.0) * dk * dk * 0.25);
  float am = sqrt(max(spectrum(-k), 0.0) * dk * dk * 0.25);
  vec2 h0 = xi * a0;
  vec2 hm = xm * am;
  o = vec4(h0, hm.x, -hm.y); // h0(k), conj(h0(-k))
}`;

const EVOLVE_FS = COMMON + `
uniform sampler2D uH0;
uniform float uL;
uniform float uTime;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  float n = float(textureSize(uH0, 0).x);
  vec2 k = (vec2(id) - n * 0.5) * (2.0 * PI / uL);
  float kl = max(length(k), 1e-6);
  vec4 h0 = texelFetch(uH0, id, 0);
  // dispersion quantised to a 1000 s repeat period (Tessendorf) keeps the fp32 phase small
  const float W0 = 2.0 * PI / 1000.0;
  float ph = floor(omegaOf(kl) / W0) * W0 * uTime;
  // exp(-i w t) with field exp(+i k.x): energy at k travels towards +k (downwind)
  vec2 e = vec2(cos(ph), -sin(ph));
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x);
  vec2 Dx = ih * (k.x / kl);
  vec2 Dz = ih * (k.y / kl);
  vec2 Dy = h;
  vec2 Dyx = ih * k.x;
  vec2 Dyz = ih * k.y;
  vec2 Dxx = -h * (k.x * k.x / kl);
  vec2 Dzz = -h * (k.y * k.y / kl);
  vec2 Dxz = -h * (k.x * k.y / kl);
  // pack two real fields into one complex signal: A + iB
  o0 = vec4(Dx.x - Dz.y, Dx.y + Dz.x, Dy.x - Dxz.y, Dy.y + Dxz.x);
  o1 = vec4(Dyx.x - Dyz.y, Dyx.y + Dyz.x, Dxx.x - Dzz.y, Dxx.y + Dzz.x);
}`;

// Radix-2 Stockham autosort pass (inverse transform).
const FFT_FS = COMMON + `
uniform sampler2D uIn0;
uniform sampler2D uIn1;
uniform int uStage;
uniform int uDir;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  int n = textureSize(uIn0, 0).x;
  int i = uDir == 0 ? id.x : id.y;
  int ns = 1 << uStage;
  int r = i & (2 * ns - 1);
  int k = r & (ns - 1);
  int j = (i >> (uStage + 1)) * ns + k;
  ivec2 a = id, b = id;
  if (uDir == 0) { a.x = j; b.x = j + n / 2; } else { a.y = j; b.y = j + n / 2; }
  float ang = PI * float(k) / float(ns);
  vec2 w = vec2(cos(ang), sin(ang));
  vec4 x0 = texelFetch(uIn0, a, 0), x1 = texelFetch(uIn0, b, 0);
  vec4 y0 = texelFetch(uIn1, a, 0), y1 = texelFetch(uIn1, b, 0);
  vec4 t0 = vec4(cmul(x1.xy, w), cmul(x1.zw, w));
  vec4 t1 = vec4(cmul(y1.xy, w), cmul(y1.zw, w));
  bool top = r < ns;
  o0 = top ? x0 + t0 : x0 - t0;
  o1 = top ? y0 + t1 : y0 - t1;
}`;

const ASSEMBLE_FS = `
uniform sampler2D uF0;
uniform sampler2D uF1;
uniform sampler2D uPrev;
uniform sampler2D uPrevA;
// bicubic Catmull-Rom of the foam channel at a texel-space position (periodic)
float foamCR(sampler2D tex, vec2 pos) {
  ivec2 n = textureSize(tex, 0);
  vec2 p = pos - 0.5;
  vec2 i = floor(p), f = p - i;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  float r = 0.0;
  for (int y = -1; y <= 2; y++) {
    float wy = y == -1 ? w0.y : y == 0 ? w1.y : y == 1 ? w2.y : w3.y;
    for (int x = -1; x <= 2; x++) {
      float wx = x == -1 ? w0.x : x == 0 ? w1.x : x == 1 ? w2.x : w3.x;
      ivec2 c = (ivec2(i) + ivec2(x, y) + n) % n;
      r += texelFetch(tex, c, 0).w * wx * wy;
    }
  }
  return r;
}
uniform float uLambda;
uniform float uDt;
uniform vec3 uFoam;  // x: jacobian threshold bias, y: generation gain, z: decay rate (1/s)
uniform vec2 uDrift; // foam advection by the wind drift (texture uv per second)
layout(location = 0) out vec4 oDisp;
layout(location = 1) out vec4 oSlope;
layout(location = 2) out vec4 oActive;
void main() {
  ivec2 id = ivec2(gl_FragCoord.xy);
  float sgn = ((id.x + id.y) & 1) == 1 ? -1.0 : 1.0;
  vec4 a = texelFetch(uF0, id, 0) * sgn;
  vec4 b = texelFetch(uF1, id, 0) * sgn;
  float Dx = a.x, Dz = a.y, Dy = a.z, Dxz = a.w;
  float Dyx = b.x, Dyz = b.y, Dxx = b.z, Dzz = b.w;
  float jx = 1.0 + uLambda * Dxx;
  float jz = 1.0 + uLambda * Dzz;
  float J = jx * jz - uLambda * uLambda * Dxz * Dxz;
  vec2 s = vec2(Dyx / max(jx, 0.25), Dyz / max(jz, 0.25));
  // residual foam drifts downwind with the surface (semi-Lagrangian, bilinear: smears into streaks)
  // Catmull-Rom resampling keeps streaks crisp (bilinear would diffuse them by metres per second)
  float prev = max(foamCR(uPrev, vec2(id) + 0.5 - uDrift * uDt * vec2(textureSize(uPrev, 0))), 0.0);
  float foam = prev * exp(-uFoam.z * uDt);
  foam += max(uFoam.x - J, 0.0) * uFoam.y * uDt;
  foam = min(foam, 3.0);
  // active breaking: the same generation, but it lives only while the crest is spilling (~0.4 s)
  float act = texelFetch(uPrevA, id, 0).r * exp(-2.5 * uDt) + max(uFoam.x - J, 0.0) * uFoam.y * uDt * 2.5;
  oActive = vec4(min(act, 2.0), 0.0, 0.0, 1.0);
  oDisp = vec4(Dx * uLambda, Dy, Dz * uLambda, foam);
  oSlope = vec4(s, s * s);
}`;

export class Ocean {
  // res: FFT size per cascade (power of two). Fine cascades can run at 128 on slower GPUs.
  constructor(gl, res = [N, N, N, N]) {
    this.gl = gl;
    this.cascades = CASCADES.map((c, i) => ({ ...c, N: res[i] }));
    const dk = (L) => (2 * Math.PI) / L;
    // band limits: cascade i covers [6*dk_i, 6*dk_{i+1})
    for (let i = 0; i < this.cascades.length; i++) {
      const c = this.cascades[i];
      c.kmin = i === 0 ? dk(c.L) * 0.5 : 6 * dk(c.L);
      c.kmax = i === this.cascades.length - 1 ? 1e9 : 6 * dk(this.cascades[i + 1].L);
      c.texel = c.L / c.N;
    }
    this.progSpectrum = new Program(gl, FULLSCREEN_VS, SPECTRUM_FS, { label: 'spectrum' });
    this.progEvolve = new Program(gl, FULLSCREEN_VS, EVOLVE_FS, { label: 'evolve' });
    this.progFFT = new Program(gl, FULLSCREEN_VS, FFT_FS, { label: 'fft' });
    this.progAssemble = new Program(gl, FULLSCREEN_VS, ASSEMBLE_FS, { label: 'assemble' });

    const f32 = (w) => new Texture(gl, { w, h: w, format: 'rgba32f', filter: 'nearest' });
    // shared FFT ping-pong buffers (two MRT pairs) per resolution
    this.fft = {};
    for (const n of new Set(res)) {
      const A = [f32(n), f32(n)], B = [f32(n), f32(n)];
      this.fft[n] = { A, B, tA: new Target(gl, A), tB: new Target(gl, B) };
    }

    const r = rng(1337);
    this.cascades.forEach((c, i) => {
      const n = c.N;
      const noise = new Float32Array(n * n * 4);
      for (let j = 0; j < noise.length; j++) noise[j] = r.gauss();
      c.noise = new Texture(gl, { w: n, h: n, format: 'rgba32f', filter: 'nearest', data: noise });
      c.h0 = f32(n);
      c.h0Target = new Target(gl, [c.h0]);
      const mk = () => new Texture(gl, { w: n, h: n, format: 'rgba16f', wrap: 'repeat', mips: true, aniso: 16 });
      c.disp = [mk(), mk()];
      c.slope = [mk(), mk()];
      const mkA = () => new Texture(gl, { w: n, h: n, format: 'r16f', wrap: 'repeat', mips: true, aniso: 16 });
      c.active = [mkA(), mkA()];
      c.targets = [new Target(gl, [c.disp[0], c.slope[0], c.active[0]]), new Target(gl, [c.disp[1], c.slope[1], c.active[1]])];
      c.cur = 0;
      // clear foam history
      for (const t of c.targets) { t.bind(); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    });
    this.params = null;
    this.lambda = 1.0;
    this.drift = [0, 0]; // m/s
  }

  // params: { wind, fetch, dir, scale, swellHs, swellT, swellDir, swellSpread, spreadBlend, choppy }
  setSpectrum(p) {
    const gl = this.gl;
    const key = JSON.stringify(p);
    if (key === this.paramsKey) return;
    this.paramsKey = key;
    this.params = { ...p };
    for (const c of this.cascades) {
      fullscreen(gl, this.progSpectrum, {
        uNoise: c.noise,
        uL: c.L,
        uBand: [c.kmin, c.kmax],
        uWind: [p.wind, p.fetch, p.dir, p.scale],
        uSwell: [p.swellHs, p.swellT, p.swellDir, p.swellSpread],
        uShortCut: 0.004, uSpreadBlend: p.spreadBlend ?? 0,
      }, c.h0Target);
    }
    this.stats = computeStats(p, this.cascades);
  }

  update(time, dt, foam) {
    const gl = this.gl;
    const P = this.prof;
    this.cascades.forEach((c, ci) => {
      P && P.section('o.evolve');
      // breaking criterion: J below 1 - z * sigma_J, sigma_J ~ lambda * sqrt(mss of the band)
      const sigmaJ = this.lambda * Math.sqrt(Math.max(this.stats.bandMss[ci], 1e-8));
      const threshold = 1 - foam[0] * sigmaJ;
      const gain = foam[1] / Math.max(sigmaJ, 0.02);
      const F = this.fft[c.N];
      const stages = Math.log2(c.N);
      fullscreen(gl, this.progEvolve, { uH0: c.h0, uL: c.L, uTime: ((time % 1000) + 1000) % 1000 }, F.tA);
      P && P.section('o.fft');
      let src = F.A, dst = F.tB, dstT = F.B;
      for (let dir = 0; dir < 2; dir++) {
        for (let s = 0; s < stages; s++) {
          fullscreen(gl, this.progFFT, { uIn0: src[0], uIn1: src[1], uStage: s, uDir: dir }, dst);
          const t = src; src = dstT; dstT = t;
          dst = dst === F.tB ? F.tA : F.tB;
        }
      }
      // src now holds the spatial-domain result
      P && P.section('o.assemble');
      const next = 1 - c.cur;
      fullscreen(gl, this.progAssemble, {
        uF0: src[0], uF1: src[1], uPrev: c.disp[c.cur], uPrevA: c.active[c.cur],
        uLambda: this.lambda, uDt: dt, uFoam: [threshold, gain, foam[2]],
        uDrift: [this.drift[0] / c.L, this.drift[1] / c.L],
      }, c.targets[next]);
      c.cur = next;
      P && P.section('o.mips');
      c.disp[c.cur].genMips();
      c.slope[c.cur].genMips();
      c.active[c.cur].genMips();
    });
  }

  textures() {
    return {
      disp: this.cascades.map((c) => c.disp[c.cur]),
      slope: this.cascades.map((c) => c.slope[c.cur]),
      active: this.cascades.map((c) => c.active[c.cur]),
      sizes: this.cascades.map((c) => c.L),
      texels: this.cascades.map((c) => c.texel),
    };
  }
}

// CPU statistics of the spectrum: significant wave height and resolved mean-square slope,
// used to derive the unresolved (sub-cascade) slope variance from Cox & Munk.
function elfouhailyCPU(k, U, fetch) {
  const ko = G / (U * U);
  const Om = Math.min(Math.max(0.84 * Math.pow(Math.tanh(Math.pow((ko * fetch) / 2.2e4, 0.4)), -0.75), 0.84), 5);
  const kp = ko * Om * Om, cp = Math.sqrt(G / kp), km = 370, cm = 0.23;
  const c = Math.sqrt((G / k) * (1 + (k / km) ** 2));
  const Lpm = Math.exp(-1.25 * (kp / k) ** 2);
  const gamma = Om <= 1 ? 1.7 : 1.7 + 6 * Math.log10(Om);
  const sigma = 0.08 * (1 + 4 / Om ** 3);
  const r = Math.sqrt(k / kp) - 1;
  const Jp = Math.pow(gamma, Math.exp((-r * r) / (2 * sigma * sigma)));
  const Bl = 0.5 * 0.006 * Math.pow(Om, 0.55) * (cp / c) * Lpm * Jp * Math.exp((-Om / Math.sqrt(10)) * r);
  const ustar = 0.03795 * U;
  const am = Math.max(ustar <= cm ? 0.01 * (1 + Math.log(ustar / cm)) : 0.01 * (1 + 3 * Math.log(ustar / cm)), 0);
  const Bh = 0.5 * am * (cm / c) * Lpm * Jp * Math.exp(-0.25 * (k / km - 1) ** 2);
  return { S: (Bl + Bh) / k ** 3, kp };
}
function swellCPU(w, Hs, Tp) {
  if (Hs <= 0) return 0;
  const wp = (2 * Math.PI) / Tp, gamma = 5;
  const sigma = w <= wp ? 0.07 : 0.09;
  const d = (w - wp) / (sigma * wp);
  return (5 / 16) * Hs * Hs * Math.pow(wp, 4) / Math.pow(w, 5) * Math.exp(-1.25 * Math.pow(wp / w, 4)) *
    (1 - 0.287 * Math.log(gamma)) * Math.pow(gamma, Math.exp(-0.5 * d * d));
}
function computeStats(p, cascades) {
  const U = Math.max(p.wind, 0.3);
  const kminAll = cascades[0].kmin;
  const last = cascades[cascades.length - 1];
  const kmaxAll = (Math.PI * last.N) / last.L;
  let m0 = 0, mss = 0;
  const band = cascades.map(() => 0);
  const steps = 4000;
  const lk0 = Math.log(kminAll), lk1 = Math.log(kmaxAll);
  for (let i = 0; i < steps; i++) {
    const lk = lk0 + ((i + 0.5) / steps) * (lk1 - lk0);
    const k = Math.exp(lk);
    const dkk = k * ((lk1 - lk0) / steps);
    const w = Math.sqrt(G * k + SIGMA_RHO * k * k * k);
    const dwdk = (G + 3 * SIGMA_RHO * k * k) / (2 * w);
    const S = elfouhailyCPU(k, U, p.fetch).S * p.scale + swellCPU(w, p.swellHs, p.swellT) * dwdk;
    const Sk = S * Math.exp(-k * k * 0.004 * 0.004);
    m0 += Sk * dkk;
    mss += k * k * Sk * dkk;
    for (let c = 0; c < cascades.length; c++) if (k >= cascades[c].kmin && k < cascades[c].kmax) band[c] += k * k * Sk * dkk;
  }
  const coxMunk = 0.003 + 0.00512 * U;
  return { hs: 4 * Math.sqrt(m0), resolvedMss: mss, coxMunk, unresolved: Math.max(coxMunk - mss, 0.002), bandMss: band };
}
