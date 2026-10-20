// HDR post: physically motivated bloom (energy-conserving mip pyramid), eye adaptation,
// AgX tone mapping, subtle grain and dithering.
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';
import { SKY_LOOKUP_GLSL } from '../sky/atmosphere.js';

const DOWN_FS = `
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uFirst;
vec3 s(vec2 uv) { return texture(uSrc, uv).rgb; }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  // 13-tap (Jimenez 2014)
  vec2 t = uTexel;
  vec3 a = s(vUv + t * vec2(-2, 2)), b = s(vUv + t * vec2(0, 2)), c = s(vUv + t * vec2(2, 2));
  vec3 d = s(vUv + t * vec2(-2, 0)), e = s(vUv), f = s(vUv + t * vec2(2, 0));
  vec3 g = s(vUv + t * vec2(-2, -2)), h = s(vUv + t * vec2(0, -2)), i = s(vUv + t * vec2(2, -2));
  vec3 j = s(vUv + t * vec2(-1, 1)), k = s(vUv + t * vec2(1, 1));
  vec3 l = s(vUv + t * vec2(-1, -1)), m = s(vUv + t * vec2(1, -1));
  vec3 col;
  if (uFirst > 0.5) {
    // Karis average on the first mip to suppress fireflies from glints
    vec3 g0 = (a + b + d + e) * 0.25, g1 = (b + c + e + f) * 0.25, g2 = (d + e + g + h) * 0.25, g3 = (e + f + h + i) * 0.25, g4 = (j + k + l + m) * 0.25;
    float w0 = 1.0 / (1.0 + lum(g0)), w1 = 1.0 / (1.0 + lum(g1)), w2 = 1.0 / (1.0 + lum(g2)), w3 = 1.0 / (1.0 + lum(g3)), w4 = 1.0 / (1.0 + lum(g4));
    col = (g0 * w0 * 0.125 + g1 * w1 * 0.125 + g2 * w2 * 0.125 + g3 * w3 * 0.125 + g4 * w4 * 0.5) /
          (w0 * 0.125 + w1 * 0.125 + w2 * 0.125 + w3 * 0.125 + w4 * 0.5);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  o = vec4(min(col, vec3(60000.0)), 1.0);
}`;

const UP_FS = `
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uRadius;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(-t.x, 0)).rgb + texture(uSrc, vUv + vec2(t.x, 0)).rgb + texture(uSrc, vUv + vec2(0, -t.y)).rgb + texture(uSrc, vUv + vec2(0, t.y)).rgb) * 2.0;
  c += texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb + texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(t.x, t.y)).rgb;
  o = vec4(c / 16.0, 1.0);
}`;

const LUM_FS = `
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  // centre-weighted metering
  vec2 d = vUv - 0.5;
  float w = exp(-dot(d, d) * 3.0);
  o = vec4(log(max(dot(c, vec3(0.2126, 0.7152, 0.0722)), 1e-6)) * w, w, 0.0, 1.0);
}`;

const ADAPT_FS = SKY_LOOKUP_GLSL + `
out vec4 o;
uniform sampler2D uLum;
uniform sampler2D uCloudShadow;
uniform float uIncident;
uniform float uLightning;
uniform sampler2D uPrev;
uniform float uDt;
uniform float uSpeed;
uniform float uLevel;
void main() {
  vec4 l = textureLod(uLum, vec2(0.5), uLevel);
  float scene = l.x / max(l.y, 1e-6);
  // incident metering: luminance of an 18% grey card under the current sun + sky light
  float vis = texture(uCloudShadow, vec2(0.5)).r;
  vec3 E = sunIlluminance() * vis * max(uSunDir.y, 0.0) + skyIrradiance();
  float grey = 0.18 * dot(E, vec3(0.2126, 0.7152, 0.0722)) / 3.14159;
  float target = exp(mix(scene, log(max(grey, 1e-6)), uIncident));
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  if (prev <= 0.0 || isnan(prev)) prev = target;
  float a = 1.0 - exp(-uDt * uSpeed);
  o = vec4(exp(mix(log(prev), log(target), a)), 0.0, 0.0, 1.0);
}`;

const COMPOSITE_FS = `
in vec2 vUv;
out vec4 o;
uniform sampler2D uHdr;
uniform sampler2D uBloom;
uniform sampler2D uAdapt;
uniform float uBloomStrength;
uniform float uExposureBias;
uniform float uMinLum;
uniform float uMaxLum;
uniform float uTime;
uniform float uGrain;
uniform float uVignette;
uniform float uFlashExposure;
uniform float uManualExposure;

vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float lo = -12.47393, hi = 4.026069;
  v = m * v;
  v = clamp(log2(max(v, vec3(1e-10))), lo, hi);
  v = (v - lo) / (hi - lo);
  return agxContrast(v);
}
vec3 agxEotf(vec3 v) {
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  return mi * v;
}
vec3 agxLook(vec3 v) {
  float luma = dot(v, vec3(0.2126, 0.7152, 0.0722));
  v = pow(max(v, vec3(0.0)), vec3(1.12));
  return luma + 1.12 * (v - luma);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 hdr = texture(uHdr, vUv).rgb;
  vec3 bloom = texture(uBloom, vUv).rgb;
  vec3 c = mix(hdr, bloom, uBloomStrength);
  float avg = texelFetch(uAdapt, ivec2(0), 0).r;
  avg = clamp(avg, uMinLum, uMaxLum);
  float exposure = uManualExposure > 0.0 ? uManualExposure : 0.18 / avg;
  exposure *= exp2(uExposureBias) / (1.0 + uFlashExposure);
  c *= exposure;
  vec2 d = vUv - 0.5;
  c *= 1.0 - uVignette * dot(d, d) * 1.6;
  c = agxEotf(agxLook(agx(c)));
  c = clamp(c, 0.0, 1.0);
  // luminance grain (film-like, stronger in mid-tones) + triangular dither against banding
  float n = hash(vUv * 1931.7 + fract(uTime * 7.31)) + hash(vUv * 1173.3 + fract(uTime * 3.17)) - 1.0;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += n * uGrain * (0.35 + 4.0 * l * (1.0 - l));
  c += (hash(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

export class Post {
  constructor(gl) {
    this.gl = gl;
    this.pDown = new Program(gl, FULLSCREEN_VS, DOWN_FS, { label: 'bloom.down' });
    this.pUp = new Program(gl, FULLSCREEN_VS, UP_FS, { label: 'bloom.up' });
    this.pLum = new Program(gl, FULLSCREEN_VS, LUM_FS, { label: 'lum' });
    this.pAdapt = new Program(gl, FULLSCREEN_VS, ADAPT_FS, { label: 'adapt' });
    this.pComp = new Program(gl, FULLSCREEN_VS, COMPOSITE_FS, { label: 'composite' });
    this.lum = new Texture(gl, { w: 256, h: 256, format: 'rg16f', mips: true });
    this.lumTarget = new Target(gl, [this.lum]);
    this.adapt = [0, 1].map(() => new Texture(gl, { w: 1, h: 1, format: 'r32f', filter: 'nearest' }));
    this.adaptTargets = this.adapt.map((t) => new Target(gl, [t]));
    for (const t of this.adaptTargets) { t.bind(); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
    this.adaptCur = 0;
    this.levels = [];
  }

  resize(w, h) {
    const gl = this.gl;
    this.levels = [];
    let lw = w >> 1, lh = h >> 1;
    for (let i = 0; i < 7 && lw > 4 && lh > 4; i++) {
      const tex = new Texture(gl, { w: lw, h: lh, format: 'rgba16f' });
      this.levels.push({ tex, target: new Target(gl, [tex]) });
      lw >>= 1; lh >>= 1;
    }
  }

  run(hdr, dt, opts) {
    const gl = this.gl;
    // bloom pyramid
    let src = hdr;
    this.levels.forEach((lv, i) => {
      fullscreen(gl, this.pDown, { uSrc: src, uTexel: [1 / src.w, 1 / src.h], uFirst: i === 0 ? 1 : 0 }, lv.target);
      src = lv.tex;
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = this.levels.length - 1; i > 0; i--) {
      const from = this.levels[i].tex;
      fullscreen(gl, this.pUp, { uSrc: from, uTexel: [1 / from.w, 1 / from.h], uRadius: 1.0 }, this.levels[i - 1].target);
    }
    gl.disable(gl.BLEND);
    // normalise accumulated bloom: sum of levels -> average
    // eye adaptation
    fullscreen(gl, this.pLum, { uSrc: hdr }, this.lumTarget);
    this.lum.genMips();
    const next = 1 - this.adaptCur;
    fullscreen(gl, this.pAdapt, {
      ...opts.skyU, uCloudShadow: opts.cloudShadow, uIncident: opts.incident ?? 0.75,
      uLum: this.lum, uPrev: this.adapt[this.adaptCur], uDt: dt, uSpeed: opts.adaptSpeed ?? 1.5, uLevel: 8,
    }, this.adaptTargets[next]);
    this.adaptCur = next;

    fullscreen(gl, this.pComp, {
      uHdr: hdr,
      uBloom: this.levels[0].tex,
      uAdapt: this.adapt[this.adaptCur],
      uBloomStrength: (opts.bloom ?? 0.04) / this.levels.length,
      uExposureBias: opts.exposureBias ?? 0,
      uMinLum: opts.minLum ?? 0.002,
      uMaxLum: opts.maxLum ?? 10,
      uTime: opts.time,
      uGrain: opts.grain ?? 0.012,
      uVignette: opts.vignette ?? 0.18,
      uFlashExposure: opts.flashExposure ?? 0,
      uManualExposure: opts.manualExposure ?? 0,
    }, null);
  }
}
