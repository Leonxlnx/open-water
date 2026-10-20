// Physically based atmosphere after Hillaire 2020 ("A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"): transmittance LUT, multiple-scattering LUT, sky-view LUT,
// plus a 2D aerial-perspective LUT specialised for sea-level surface points.
// Units: kilometres. Radiance is relative to a solar illuminance of 1.
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';

export const ATMO_GLSL = `
const float PI = 3.14159265359;
const float Rg = 6360.0;
const float Rt = 6460.0;
uniform vec3 uRayleigh;   // scattering at sea level (1/km)
uniform vec2 uMie;        // scattering, extinction at sea level (1/km)
uniform float uMieH;      // scale height of aerosols (km)
uniform vec3 uOzone;      // absorption (1/km)
uniform float uMieG;

struct Medium { vec3 scatR; float scatM; vec3 ext; };
Medium medium(float h) {
  h = max(h, 0.0);
  float dR = exp(-h / 8.0);
  float dM = exp(-h / uMieH);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  Medium m;
  m.scatR = uRayleigh * dR;
  m.scatM = uMie.x * dM;
  m.ext = m.scatR + vec3(uMie.y * dM) + uOzone * dO;
  return m;
}

// distance to sphere of radius R from ro (origin-centred), -1 if none
float raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if (d < 0.0) return -1.0;
  d = sqrt(d);
  float t0 = -b - d, t1 = -b + d;
  if (t0 > 0.0) return t0;
  if (t1 > 0.0) return t1;
  return -1.0;
}

float rayleighPhase(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float miePhase(float c, float g) {
  // Cornette-Shanks
  float g2 = g * g;
  float k = 3.0 / (8.0 * PI) * (1.0 - g2) / (2.0 + g2);
  return k * (1.0 + c * c) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5);
}

vec2 transmittanceUv(float r, float mu) {
  float H = sqrt(Rt * Rt - Rg * Rg);
  float rho = sqrt(max(0.0, r * r - Rg * Rg));
  float disc = r * r * (mu * mu - 1.0) + Rt * Rt;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dmin = Rt - r, dmax = rho + H;
  return vec2((d - dmin) / (dmax - dmin), rho / H);
}
`;

const TRANSMITTANCE_FS = ATMO_GLSL + `
in vec2 vUv;
out vec4 o;
void main() {
  float H = sqrt(Rt * Rt - Rg * Rg);
  float rho = H * vUv.y;
  float r = sqrt(rho * rho + Rg * Rg);
  float dmin = Rt - r, dmax = rho + H;
  float d = dmin + vUv.x * (dmax - dmin);
  float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
  vec3 ro = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(1.0 - mu * mu), mu, 0.0);
  float tmax = raySphere(ro, rd, Rt);
  const int STEPS = 48;
  vec3 tau = vec3(0.0);
  float dt = tmax / float(STEPS);
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * dt;
    tau += medium(length(p) - Rg).ext * dt;
  }
  o = vec4(exp(-tau), 1.0);
}`;

const SKY_COMMON = ATMO_GLSL + `
uniform sampler2D uTransmittance;
vec3 sunTransmittance(vec3 p, vec3 sun) {
  float r = length(p);
  float mu = dot(p / r, sun);
  // below the horizon of the planet: no direct sun
  float sinH = Rg / r;
  float cosH = -sqrt(max(0.0, 1.0 - sinH * sinH));
  float fade = smoothstep(cosH - 0.01, cosH + 0.01, mu);
  return texture(uTransmittance, transmittanceUv(r, mu)).rgb * fade;
}
`;

const MULTISCATTER_FS = SKY_COMMON + `
in vec2 vUv;
out vec4 o;
uniform float uGroundAlbedo;
void main() {
  float muS = vUv.x * 2.0 - 1.0;
  float h = mix(0.0, Rt - Rg, vUv.y);
  vec3 ro = vec3(0.0, Rg + h + 0.01, 0.0);
  vec3 sun = vec3(sqrt(max(0.0, 1.0 - muS * muS)), muS, 0.0);
  const int SQ = 8;
  vec3 L2 = vec3(0.0), fms = vec3(0.0);
  for (int i = 0; i < SQ; i++) for (int j = 0; j < SQ; j++) {
    float th = PI * (float(i) + 0.5) / float(SQ);
    float ph = acos(1.0 - 2.0 * (float(j) + 0.5) / float(SQ));
    vec3 rd = vec3(cos(th) * sin(ph), cos(ph), sin(th) * sin(ph));
    float tG = raySphere(ro, rd, Rg);
    float tT = raySphere(ro, rd, Rt);
    float tmax = tG > 0.0 ? tG : tT;
    const int STEPS = 20;
    float dt = tmax / float(STEPS);
    vec3 T = vec3(1.0), L = vec3(0.0), F = vec3(0.0);
    for (int s = 0; s < STEPS; s++) {
      vec3 p = ro + rd * (float(s) + 0.5) * dt;
      Medium m = medium(length(p) - Rg);
      vec3 sT = sunTransmittance(p, sun);
      vec3 scat = m.scatR + m.scatM;
      vec3 S = scat * sT / (4.0 * PI);
      vec3 ext = max(m.ext, vec3(1e-7));
      vec3 sd = exp(-ext * dt);
      L += T * (S - S * sd) / ext;
      F += T * (scat - scat * sd) / ext;
      T *= sd;
    }
    if (tG > 0.0) {
      vec3 p = ro + rd * tG;
      vec3 n = normalize(p);
      L += T * sunTransmittance(p, sun) * max(dot(n, sun), 0.0) * uGroundAlbedo / PI;
    }
    L2 += L; fms += F;
  }
  L2 /= float(SQ * SQ);
  fms /= float(SQ * SQ);
  o = vec4(L2 / (1.0 - fms), 1.0);
}`;

const SCATTER_FN = `
uniform sampler2D uMultiScatter;
vec3 msLookup(float h, float muS) {
  return texture(uMultiScatter, vec2(muS * 0.5 + 0.5, clamp(h / (Rt - Rg), 0.0, 1.0))).rgb;
}
// integrate in-scattered radiance along ro + rd * [0, tmax]; returns radiance and transmittance
void integrate(vec3 ro, vec3 rd, float tmax, vec3 sun, int steps, out vec3 L, out vec3 T) {
  float c = dot(rd, sun);
  float pR = rayleighPhase(c), pM = miePhase(c, uMieG);
  L = vec3(0.0); T = vec3(1.0);
  float prev = 0.0;
  for (int s = 0; s < 64; s++) {
    if (s >= steps) break;
    // quadratic step distribution: dense near the camera
    float f = (float(s) + 0.5) / float(steps);
    float t = tmax * f * f;
    float tn = tmax * pow((float(s) + 1.0) / float(steps), 2.0);
    float dt = tn - prev;
    prev = tn;
    vec3 p = ro + rd * t;
    float h = length(p) - Rg;
    Medium m = medium(h);
    vec3 sT = sunTransmittance(p, sun);
    vec3 ms = msLookup(h, dot(normalize(p), sun));
    vec3 S = (m.scatR * pR + m.scatM * pM) * sT + (m.scatR + m.scatM) * ms;
    vec3 ext = max(m.ext, vec3(1e-7));
    vec3 sd = exp(-ext * dt);
    L += T * (S - S * sd) / ext;
    T *= sd;
  }
}
`;

const SKYVIEW_FS = SKY_COMMON + SCATTER_FN + `
in vec2 vUv;
out vec4 o;
uniform vec3 uSun;
uniform float uCamH; // km
// direction encoding shared with lookup: x = azimuth relative to sun (0..pi), y = elevation (non-linear)
void main() {
  float az = vUv.x * PI;
  float v = vUv.y * 2.0 - 1.0;
  float el = sign(v) * v * v * PI * 0.5;
  vec3 sunH = normalize(vec3(uSun.x, 0.0, uSun.z) + vec3(1e-6, 0.0, 0.0));
  vec3 sunR = normalize(cross(vec3(0.0, 1.0, 0.0), sunH));
  vec3 hdir = sunH * cos(az) + sunR * sin(az);
  vec3 rd = hdir * cos(el) + vec3(0.0, sin(el), 0.0);
  vec3 ro = vec3(0.0, Rg + max(uCamH, 0.001), 0.0);
  float tG = raySphere(ro, rd, Rg);
  float tT = raySphere(ro, rd, Rt);
  float tmax = tG > 0.0 ? tG : tT;
  vec3 L, T;
  integrate(ro, rd, tmax, uSun, 40, L, T);
  o = vec4(L, 1.0);
}`;

// Aerial perspective for sea-level points: x = azimuth relative to sun (0..pi), y = sqrt(distance / max)
const AERIAL_FS = SKY_COMMON + SCATTER_FN + `
in vec2 vUv;
layout(location = 0) out vec4 oL;
layout(location = 1) out vec4 oT;
uniform vec3 uSun;
uniform float uCamH;
uniform float uMaxDist;
void main() {
  float az = vUv.x * PI;
  float d = uMaxDist * vUv.y * vUv.y;
  vec3 sunH = normalize(vec3(uSun.x, 0.0, uSun.z) + vec3(1e-6, 0.0, 0.0));
  vec3 sunR = normalize(cross(vec3(0.0, 1.0, 0.0), sunH));
  vec3 hdir = sunH * cos(az) + sunR * sin(az);
  vec3 ro = vec3(0.0, Rg + max(uCamH, 0.001), 0.0);
  float ang = d / Rg;
  vec3 target = (vec3(0.0, cos(ang), 0.0) + hdir * sin(ang)) * Rg;
  vec3 seg = target - ro;
  float len = length(seg);
  vec3 L, T;
  if (len < 1e-5) { L = vec3(0.0); T = vec3(1.0); }
  else integrate(ro, seg / len, len, uSun, 24, L, T);
  oL = vec4(L, 1.0);
  oT = vec4(T, 1.0);
}`;

export class Atmosphere {
  constructor(gl) {
    this.gl = gl;
    this.transmittance = new Texture(gl, { w: 256, h: 64, format: 'rgba16f' });
    this.multiScatter = new Texture(gl, { w: 32, h: 32, format: 'rgba16f' });
    this.skyView = new Texture(gl, { w: 256, h: 128, format: 'rgba16f' });
    this.aerialL = new Texture(gl, { w: 64, h: 64, format: 'rgba16f' });
    this.aerialT = new Texture(gl, { w: 64, h: 64, format: 'rgba16f' });
    this.tTrans = new Target(gl, [this.transmittance]);
    this.tMS = new Target(gl, [this.multiScatter]);
    this.tSky = new Target(gl, [this.skyView]);
    this.tAerial = new Target(gl, [this.aerialL, this.aerialT]);
    this.pTrans = new Program(gl, FULLSCREEN_VS, TRANSMITTANCE_FS, { label: 'atmo.trans' });
    this.pMS = new Program(gl, FULLSCREEN_VS, MULTISCATTER_FS, { label: 'atmo.ms' });
    this.pSky = new Program(gl, FULLSCREEN_VS, SKYVIEW_FS, { label: 'atmo.sky' });
    this.pAerial = new Program(gl, FULLSCREEN_VS, AERIAL_FS, { label: 'atmo.aerial' });
    this.maxDist = 60; // km
    this.key = '';
  }

  mediumUniforms(haze) {
    // haze: multiplier of sea-level aerosol density (marine boundary layer)
    const mieScat = 0.0036 * haze;
    const mieExt = mieScat / 0.9; // sea-salt aerosols are bright: single scattering albedo ~0.9
    return {
      uRayleigh: [5.802e-3, 13.558e-3, 33.1e-3],
      uMie: [mieScat, mieExt],
      uMieH: 1.2,
      uOzone: [0.65e-3, 1.881e-3, 0.085e-3],
      uMieG: 0.78,
    };
  }

  update(sunDir, camHeightM, haze) {
    const gl = this.gl;
    const med = this.mediumUniforms(haze);
    const key = haze.toFixed(4);
    if (key !== this.key) {
      this.key = key;
      fullscreen(gl, this.pTrans, med, this.tTrans);
      fullscreen(gl, this.pMS, { ...med, uTransmittance: this.transmittance, uGroundAlbedo: 0.06 }, this.tMS);
    }
    const common = { ...med, uTransmittance: this.transmittance, uMultiScatter: this.multiScatter, uSun: sunDir, uCamH: camHeightM / 1000 };
    fullscreen(gl, this.pSky, common, this.tSky);
    fullscreen(gl, this.pAerial, { ...common, uMaxDist: this.maxDist }, this.tAerial);
    this.uniforms = med;
  }
}

// GLSL helpers for consumers of the LUTs (water, sky, clouds).
export const SKY_LOOKUP_GLSL = `
uniform sampler2D uSkyView;
uniform sampler2D uAerialL;
uniform sampler2D uAerialT;
uniform sampler2D uTransmittance;
uniform vec3 uSunDir;
uniform float uAerialMax;
uniform float uHazeSun;   // fraction of direct sun reaching the haze below the clouds
uniform sampler2D uIrradiance;
uniform float uCamHkm;
vec3 skyIrradiance() { return texelFetch(uIrradiance, ivec2(0), 0).rgb; }
vec2 sunBasisAz(vec3 d) {
  vec3 sunH = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-6, 0.0, 0.0));
  vec3 sunR = normalize(cross(vec3(0.0, 1.0, 0.0), sunH));
  vec2 h = vec2(dot(d, sunH), dot(d, sunR));
  return h;
}
vec3 skyRadiance(vec3 d) {
  vec2 h = sunBasisAz(d);
  float az = abs(atan(h.y, h.x)) / 3.14159265;
  float el = asin(clamp(d.y, -1.0, 1.0)) / (3.14159265 * 0.5);
  float v = sign(el) * sqrt(abs(el));
  return texture(uSkyView, vec2(az, v * 0.5 + 0.5)).rgb;
}
void aerial(vec3 d, float distKm, out vec3 L, out vec3 T) {
  vec2 h = sunBasisAz(d);
  float az = abs(atan(h.y, h.x)) / 3.14159265;
  vec2 uv = vec2(az, sqrt(clamp(distKm / uAerialMax, 0.0, 1.0)));
  L = texture(uAerialL, uv).rgb;
  T = texture(uAerialT, uv).rgb;
  // under a cloud deck the haze is lit by diffuse light from the cloud base, not the sun
  float ext = 1.0 - dot(T, vec3(0.3333));
  L = L * uHazeSun + ext * skyIrradiance() * (0.9 / (4.0 * 3.14159)) * (1.0 - uHazeSun);
}
vec3 sunTransmittanceAt(float hKm, float mu) {
  const float Rg_ = 6360.0, Rt_ = 6460.0;
  float r = Rg_ + max(hKm, 0.0005);
  float H = sqrt(Rt_ * Rt_ - Rg_ * Rg_);
  float rho = sqrt(max(0.0, r * r - Rg_ * Rg_));
  float disc = r * r * (mu * mu - 1.0) + Rt_ * Rt_;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dmin = Rt_ - r, dmax = rho + H;
  float sinH = Rg_ / r;
  float cosH = -sqrt(max(0.0, 1.0 - sinH * sinH));
  float fade = smoothstep(cosH - 0.004, cosH + 0.004, mu);
  return texture(uTransmittance, vec2((d - dmin) / (dmax - dmin), rho / H)).rgb * fade;
}
vec3 sunIlluminance() { return sunTransmittanceAt(uCamHkm, uSunDir.y); }
// Rain / mist below the cloud deck: extinction uFogDensity (1/m) up to uFogTop (m).
// Lit by the diffuse sky/cloud light plus a forward-scattering sun lobe (droplets, g ~ 0.7).
uniform float uFogDensity;
uniform float uFogTop;
vec3 fogRadiance(vec3 dir) {
  float c = dot(dir, uSunDir);
  float g = 0.7;
  float ph = (1.0 - g * g) / (4.0 * 3.14159 * pow(1.0 + g * g - 2.0 * g * c, 1.5));
  return skyIrradiance() * (0.92 / (4.0 * 3.14159)) + sunIlluminance() * uHazeSun * ph * 0.92;
}
float fogPathLength(vec3 dir, float dist) {
  // the veil only exists below the cloud base
  float toTop = dir.y > 0.0 ? uFogTop / max(dir.y, 0.015) : 1e9;
  return min(dist, toTop);
}
vec3 applyFog(vec3 col, vec3 dir, float dist) {
  float T = exp(-uFogDensity * fogPathLength(dir, dist));
  return mix(fogRadiance(dir), col, T);
}
`;
