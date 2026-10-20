// Volumetric clouds (Nubis-style): procedural tileable Perlin-Worley / Worley 3D noise,
// a scrolling weather map, Beer-powder lighting with multiple-scattering octaves,
// temporal accumulation at reduced resolution, a reflection-probe variant and a
// cloud-shadow map that dapples the sea with moving light.
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';
import { SKY_LOOKUP_GLSL } from './atmosphere.js';

const NOISE_COMMON = `
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float worley(vec3 uv, float freq) {
  vec3 id = floor(uv * freq);
  vec3 p = fract(uv * freq);
  float md = 1e4;
  for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) for (int z = -1; z <= 1; z++) {
    vec3 o = vec3(x, y, z);
    vec3 h = hash33(mod(id + o, vec3(freq))) + o;
    vec3 d = p - h;
    md = min(md, dot(d, d));
  }
  return 1.0 - md;
}
vec3 grad3(vec3 p) { return normalize(hash33(p) * 2.0 - 1.0); }
float gnoise(vec3 x, float freq) {
  vec3 p = floor(x), w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float r = 0.0;
  float v[8];
  for (int i = 0; i < 8; i++) {
    vec3 o = vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    v[i] = dot(grad3(mod(p + o, freq)), w - o);
  }
  return mix(mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y),
             mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y), u.z);
}
float perlinFbm(vec3 p, float freq, int oct) {
  float G = exp2(-0.85), amp = 1.0, noise = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    noise += amp * gnoise(p * freq, freq);
    freq *= 2.0; amp *= G;
  }
  return noise;
}
float worleyFbm(vec3 p, float f) {
  return worley(p, f) * 0.625 + worley(p, f * 2.0) * 0.25 + worley(p, f * 4.0) * 0.125;
}
float remap(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }
`;

const SHAPE_FS = NOISE_COMMON + `
uniform float uSlice;
uniform float uSize;
out vec4 o;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uSize, (uSlice + 0.5) / uSize);
  float pfbm = mix(1.0, perlinFbm(p, 4.0, 7), 0.5);
  pfbm = abs(pfbm * 2.0 - 1.0);
  float w0 = worleyFbm(p, 4.0);
  float pw = remap(pfbm, 0.0, 1.0, w0, 1.0);
  o = vec4(clamp(pw, 0.0, 1.0), w0, worleyFbm(p, 8.0), worleyFbm(p, 16.0));
}`;

const DETAIL_FS = NOISE_COMMON + `
uniform float uSlice;
uniform float uSize;
out vec4 o;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uSize, (uSlice + 0.5) / uSize);
  o = vec4(worleyFbm(p, 2.0), worleyFbm(p, 4.0), worleyFbm(p, 8.0), 1.0);
}`;

const WEATHER_FS = NOISE_COMMON + `
in vec2 vUv;
out vec4 o;
void main() {
  vec3 p = vec3(vUv, 0.37);
  float base = perlinFbm(p, 6.0, 6) * 0.5 + 0.5;
  float cells = worleyFbm(p, 10.0);
  float cov = clamp(remap(base, 0.25, 0.85, 0.0, 1.0) * 0.6 + cells * 0.55 - 0.15, 0.0, 1.0);
  float type = clamp(perlinFbm(p + 3.7, 3.0, 4) * 0.5 + 0.5, 0.0, 1.0);
  float big = clamp(perlinFbm(p + 9.1, 2.0, 3) * 0.6 + 0.5, 0.0, 1.0);
  o = vec4(cov, type, big, 1.0);
}`;

// ---------------------------------------------------------------- raymarch core
export const CLOUD_GLSL = `
uniform sampler3D uShape;
uniform sampler3D uDetail;
uniform sampler2D uWeather;
uniform vec3 uWindOffset;     // metres of advection (xz) and detail evolution (y)
uniform float uCoverage;
uniform float uBase;          // m
uniform float uTop;           // m
uniform float uDensity;       // extinction scale (1/m)
uniform float uDark;          // storm darkness 0..1
uniform vec4 uFlash;          // lightning position xyz (m), intensity
uniform vec3 uFlashColor;
const float RG_M = 6360000.0;

float remapc(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }

float cloudDensity(vec3 p, float hf, bool detail) {
  vec2 wuv = (p.xz + uWindOffset.xz) / 30000.0;
  vec4 wm = texture(uWeather, wuv);
  float c = smoothstep(1.0 - uCoverage - 0.18, 1.0 - uCoverage + 0.2, wm.r * 0.85 + wm.b * 0.25 * uCoverage);
  if (c <= 0.001) return 0.0;
  vec3 sp = (p + vec3(uWindOffset.x, 0.0, uWindOffset.z)) / 3000.0;
  vec4 n = texture(uShape, sp);
  float wf = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  // vertical profile. Fair weather: cumulus towers with type-dependent tops.
  // Storm: a layer deck whose base undulates (rolls, scud) and whose thickness varies 2-3x,
  // which is what gives an overcast its mottled light and dark patches.
  float baseFrac = mix(0.0, (wf - 0.45) * 0.14 + 0.03, uDark);
  float topCu = mix(0.45, 1.0, wm.g);
  float topSt = mix(0.3, 1.0, clamp(wm.b * 0.8 + n.r * 0.5 - 0.15, 0.0, 1.0));
  float top = mix(topCu, topSt, uDark);
  float hg = smoothstep(baseFrac, baseFrac + mix(0.07, 0.05, uDark), hf) * (1.0 - smoothstep(top * 0.55, top, hf));
  float base = remapc(n.r, wf - 1.0, 1.0, 0.0, 1.0);
  float d = base * hg;
  d = remapc(d, 1.0 - c, 1.0, 0.0, 1.0) * c;
  if (d <= 0.0) return 0.0;
  if (detail) {
    vec3 dp = (p + uWindOffset * vec3(1.15, 1.0, 1.15)) / 420.0;
    vec3 dn = texture(uDetail, dp).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // wispy at the base, billowy towards the tops
    float dm = mix(df, 1.0 - df, clamp(hf * 5.0, 0.0, 1.0));
    d = remapc(d, dm * 0.45, 1.0, 0.0, 1.0);
  }
  return max(d, 0.0) * uDensity;
}

float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }

vec2 shellHits(vec3 ro, vec3 rd, float R) {
  vec3 o = ro + vec3(0.0, RG_M, 0.0);
  float b = dot(o, rd);
  float c = dot(o, o) - R * R;
  float disc = b * b - c;
  if (disc < 0.0) return vec2(-1.0);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}
float heightOf(vec3 p) { return length(p + vec3(0.0, RG_M, 0.0)) - RG_M; }

// returns rgb in-scattered radiance (sun illuminance = 1 units), a = transmittance; also mean distance
vec4 marchClouds(vec3 ro, vec3 rd, int steps, int lightSteps, float jitter, vec3 sunE, vec3 ambTop, vec3 ambBot, out float meanDist) {
  meanDist = 0.0;
  if (uCoverage < 0.01) return vec4(0.0, 0.0, 0.0, 1.0);
  vec2 hb = shellHits(ro, rd, RG_M + uBase);
  vec2 ht = shellHits(ro, rd, RG_M + uTop);
  float t0, t1;
  float h0 = heightOf(ro);
  if (h0 < uBase) {
    if (rd.y < -0.02) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = hb.y; t1 = ht.y;
  } else if (h0 < uTop) {
    t0 = 0.0; t1 = rd.y > 0.0 ? ht.y : (hb.x > 0.0 ? hb.x : ht.y);
  } else {
    if (ht.x < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = ht.x; t1 = hb.x > 0.0 ? hb.x : ht.y;
  }
  t1 = min(t1, t0 + 60000.0);
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  // adaptive stepping: coarse probes in empty space, fine steps inside clouds.
  // Fine step grows with distance (pixel footprint) to bound the cost near the horizon.
  float fine = clamp(t0 * 0.006, 28.0, 450.0) * (64.0 / float(steps));
  float coarse = fine * 3.0;
  float t = t0 + coarse * jitter;
  vec3 L = vec3(0.0);
  float T = 1.0;
  float wsum = 0.0;
  float cosT = dot(rd, uSunDir);
  // multiple-scattering octaves (Wrenninge 2013): energy a^i, extinction b^i, eccentricity c^i
  float ph0 = mix(hg(cosT, 0.82), hg(cosT, -0.3), 0.25);
  float ph1 = mix(hg(cosT, 0.41), hg(cosT, -0.15), 0.25);
  float ph2 = mix(hg(cosT, 0.2), hg(cosT, -0.07), 0.25);
  float thick = uTop - uBase;
  bool inside = false;
  bool allowBack = true;
  int miss = 0;
  for (int i = 0; i < 220; i++) {
    if (i >= steps * 3 || T < 0.008 || t > t1) break;
    vec3 p = ro + rd * t;
    float h = heightOf(p);
    float hf = clamp((h - uBase) / thick, 0.0, 1.0);
    if (!inside) {
      if (cloudDensity(p, hf, false) > 0.0) {
        inside = true; miss = 0;
        if (allowBack) { t = max(t - coarse, t0); allowBack = false; continue; }
      } else { t += coarse; continue; }
    }
    float sigma = cloudDensity(p, hf, true);
    float stepLen = fine * (1.0 + t * 0.00002);
    if (sigma > 0.0) {
      miss = 0;
      // light march towards the sun (geometric step growth)
      float tau = 0.0;
      float ls = 45.0;
      vec3 lp = p;
      for (int j = 0; j < 8; j++) {
        if (j >= lightSteps) break;
        lp += uSunDir * ls;
        float lh = heightOf(lp);
        if (lh > uTop || lh < uBase - 50.0) break;
        tau += cloudDensity(lp, clamp((lh - uBase) / thick, 0.0, 1.0), j < 3) * ls;
        ls *= 1.85;
      }
      float ms = ph0 * exp(-tau) + 0.5 * ph1 * exp(-0.5 * tau) + 0.25 * ph2 * exp(-0.25 * tau);
      // powder: in-scattering probability is low at cloud edges facing the light
      float powder = 1.0 - exp(-2.0 * tau - sigma * 80.0);
      // optical depth of the column above: diffuse light filtering down through the deck
      float tauUp = 0.0;
      if (uCoverage > 0.55) {
        float us = 180.0;
        vec3 up = p;
        for (int j = 0; j < 4; j++) {
          up.y += us;
          float uh = heightOf(up);
          if (uh > uTop) break;
          tauUp += cloudDensity(up, clamp((uh - uBase) / thick, 0.0, 1.0), false) * us;
          us *= 2.4;
        }
      } else {
        tauUp = sigma * (1.0 - hf) * thick * 0.35;
      }
      // two-stream diffusion transmittance for thick media (asymmetry g ~ 0.85): 1/(1 + 0.75(1-g) tau)
      float diffSun = 1.0 / (1.0 + 0.11 * tau);
      float diffUp = 1.0 / (1.0 + 0.11 * tauUp);
      vec3 sun = sunE * (ms * mix(1.0, powder, 0.55 * (1.0 - max(cosT, 0.0))) + diffSun * 0.06 * max(uSunDir.y + 0.1, 0.0));
      vec3 amb = ambTop * diffUp * mix(0.6, 1.0, hf) + ambBot * (1.0 - hf) * diffUp * 2.0;
      vec3 S = (sun + amb) * sigma;
      if (uFlash.w > 0.0) {
        float fd = length(p - uFlash.xyz);
        S += uFlashColor * uFlash.w * sigma * exp(-fd / 1400.0) / (1.0 + fd * fd * 1e-6);
      }
      float a = exp(-sigma * stepLen);
      vec3 Sint = (S - S * a) / max(sigma, 1e-7);
      L += T * Sint;
      wsum += T * (1.0 - a);
      meanDist += t * T * (1.0 - a);
      T *= a;
    } else if (++miss > 5) {
      inside = false;
    }
    t += stepLen;
  }
  meanDist = wsum > 0.0 ? meanDist / wsum : t0;
  // early termination leaves a residual: treat it as opaque
  T = clamp((T - 0.01) / 0.99, 0.0, 1.0);
  return vec4(L, T);
}
`;

const SCREEN_FS = SKY_LOOKUP_GLSL + CLOUD_GLSL + `
in vec2 vUv;
out vec4 o;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform sampler2D uHistory;
uniform float uFrame;
uniform float uBlend;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform int uSteps;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  vec3 rd = normalize(w.xyz / w.w - uCamPos);
  float j = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  float hKm = max(uBase, 0.0) * 0.001;
  vec3 sunE = sunTransmittanceAt(hKm + 0.5, uSunDir.y);
  vec3 zen = skyRadiance(vec3(0.0, 1.0, 0.0));
  vec3 hor = skyRadiance(normalize(vec3(uSunDir.z, 0.15, -uSunDir.x)));
  vec3 ambTop = (zen * 0.55 + hor * 0.45) * uAmbTop;
  vec3 ambBot = (sunTransmittanceAt(0.0, uSunDir.y) * max(uSunDir.y, 0.0) + zen * 3.14159) * 0.06 / 3.14159 * uAmbBot;
  float md;
  vec4 c = marchClouds(uCamPos, rd, uSteps, 6, j, sunE, ambTop, ambBot, md);
  // aerial perspective toward the cloud
  if (c.a < 0.999) {
    vec3 aL, aT;
    aerial(rd, md * 0.001, aL, aT);
    vec3 sky = skyRadiance(rd);
    c.rgb = c.rgb * aT + aL * (1.0 - c.a) * 0.9;
  }
  // temporal accumulation (clouds are effectively at infinity: reproject by direction)
  vec4 prevClip = uPrevViewProj * vec4(uCamPos + rd * 1e4, 1.0);
  vec2 puv = prevClip.xy / prevClip.w * 0.5 + 0.5;
  if (prevClip.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0))) && uBlend < 1.0) {
    vec4 h = texture(uHistory, puv);
    c = mix(h, c, uBlend);
  }
  o = c;
}`;

const ENV_FS = SKY_LOOKUP_GLSL + CLOUD_GLSL + `
in vec2 vUv;
out vec4 o;
uniform vec3 uCamPos;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform float uFrame;
uniform sampler2D uHistory;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * 3.14159265;
  float theta = vUv.y * 3.14159265;
  vec3 rd = vec3(cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  if (rd.y < 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  rd = normalize(rd + vec3(0.0, 0.002, 0.0));
  float j = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  vec3 sunE = sunTransmittanceAt(uBase * 0.001 + 0.5, uSunDir.y);
  vec3 zen = skyRadiance(vec3(0.0, 1.0, 0.0));
  vec3 hor = skyRadiance(normalize(vec3(uSunDir.z, 0.15, -uSunDir.x)));
  vec3 ambTop = (zen * 0.55 + hor * 0.45) * uAmbTop;
  vec3 ambBot = (sunTransmittanceAt(0.0, uSunDir.y) * max(uSunDir.y, 0.0) + zen * 3.14159) * 0.06 / 3.14159 * uAmbBot;
  float md;
  vec4 c = marchClouds(uCamPos, rd, 40, 4, j, sunE, ambTop, ambBot, md);
  if (c.a < 0.999) {
    vec3 aL, aT;
    aerial(rd, md * 0.001, aL, aT);
    c.rgb = c.rgb * aT + aL * (1.0 - c.a) * 0.9;
  }
  vec4 h = texture(uHistory, vUv);
  o = mix(h, c, uFrame < 1.5 ? 1.0 : 0.25);
}`;

const SHADOW_FS = 'uniform vec3 uSunDir;\n' + CLOUD_GLSL + `
in vec2 vUv;
out vec4 o;
uniform vec4 uRect; // origin xz, size
void main() {
  vec3 p0 = vec3(uRect.x + vUv.x * uRect.z, 0.0, uRect.y + vUv.y * uRect.z);
  vec3 L = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.03), uSunDir.z));
  float tb = uBase / L.y, tt = uTop / L.y;
  float tau = 0.0;
  const int N = 16;
  float dt = (tt - tb) / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = p0 + L * (tb + (float(i) + 0.5) * dt);
    float hf = (p.y - uBase) / (uTop - uBase);
    tau += cloudDensity(p, hf, false) * dt;
  }
  o = vec4(exp(-tau * 0.85), 0.0, 0.0, 1.0);
}`;

export class Clouds {
  constructor(gl) {
    this.gl = gl;
    this.shape = this.make3D(128, SHAPE_FS, 'clouds.shape');
    this.detail = this.make3D(32, DETAIL_FS, 'clouds.detail');
    this.weatherMap = new Texture(gl, { w: 512, h: 512, format: 'rgba8', wrap: 'repeat', mips: true });
    fullscreen(gl, new Program(gl, FULLSCREEN_VS, WEATHER_FS, { label: 'clouds.weather' }), {}, new Target(gl, [this.weatherMap]));
    this.weatherMap.genMips();
    this.pScreen = new Program(gl, FULLSCREEN_VS, SCREEN_FS, { label: 'clouds.screen' });
    this.pEnv = new Program(gl, FULLSCREEN_VS, ENV_FS, { label: 'clouds.env' });
    this.pShadow = new Program(gl, FULLSCREEN_VS, SHADOW_FS, { label: 'clouds.shadow' });
    this.envTex = [0, 1].map(() => new Texture(gl, { w: 384, h: 192, format: 'rgba16f' }));
    this.envTargets = this.envTex.map((t) => new Target(gl, [t]));
    this.envCur = 0;
    this.shadow = new Texture(gl, { w: 256, h: 256, format: 'r16f' });
    this.shadowTarget = new Target(gl, [this.shadow]);
    this.shadowSize = 24000;
    this.frame = 0;
  }

  make3D(size, fs, label) {
    const gl = this.gl;
    const tex = new Texture(gl, { w: size, h: size, d: size, format: 'rgba8', wrap: 'repeat', mips: true });
    const prog = new Program(gl, FULLSCREEN_VS, fs, { label });
    for (let z = 0; z < size; z++) {
      const t = new Target(gl, [tex], { layer: z });
      fullscreen(gl, prog, { uSlice: z, uSize: size }, t);
      gl.deleteFramebuffer(t.fbo);
    }
    tex.genMips();
    return tex;
  }

  resize(w, h) {
    const gl = this.gl;
    this.w = Math.ceil(w / 2); this.h = Math.ceil(h / 2);
    this.tex = [0, 1].map(() => new Texture(gl, { w: this.w, h: this.h, format: 'rgba16f' }));
    this.targets = this.tex.map((t) => new Target(gl, [t]));
    this.cur = 0;
    this.reset = true;
  }

  uniforms(u) {
    return {
      uShape: this.shape, uDetail: this.detail, uWeather: this.weatherMap,
      uWindOffset: u.windOffset, uCoverage: u.coverage, uBase: u.base, uTop: u.top,
      uDensity: u.density, uDark: u.dark, uFlash: u.flash, uFlashColor: u.flashColor,
    };
  }

  render(skyU, u, cam) {
    const gl = this.gl;
    this.frame++;
    const cu = this.uniforms(u);
    // cloud shadow map centred on the camera, snapped to texels to avoid crawling
    const texel = this.shadowSize / 256;
    const ox = Math.floor((cam.pos[0] - this.shadowSize / 2) / texel) * texel;
    const oz = Math.floor((cam.pos[2] - this.shadowSize / 2) / texel) * texel;
    this.shadowRect = [ox, oz, 1 / this.shadowSize, 1 / this.shadowSize];
    fullscreen(gl, this.pShadow, { ...cu, uSunDir: skyU.uSunDir, uRect: [ox, oz, this.shadowSize, 0] }, this.shadowTarget);

    const amb = { uAmbTop: u.ambTop || [1, 1, 1], uAmbBot: u.ambBot || [1, 1, 1] };
    // reflection probe clouds (amortised via history blend)
    const en = 1 - this.envCur;
    fullscreen(gl, this.pEnv, { ...skyU, ...cu, ...amb, uCamPos: cam.pos, uFrame: this.reset ? 0 : this.frame, uHistory: this.envTex[this.envCur] }, this.envTargets[en]);
    this.envCur = en;

    const next = 1 - this.cur;
    fullscreen(gl, this.pScreen, {
      ...skyU, ...cu, ...amb,
      uInvViewProj: cam.inv, uPrevViewProj: this.prevVP || cam.vp, uCamPos: cam.pos,
      uHistory: this.tex[this.cur], uFrame: this.frame % 64, uBlend: this.reset ? 1 : u.blend ?? 0.2,
      uSteps: u.steps ?? 64,
    }, this.targets[next]);
    this.cur = next;
    this.prevVP = cam.vp;
    this.reset = false;
  }

  get screen() { return this.tex[this.cur]; }
  get env() { return this.envTex[this.envCur]; }
}
