// Physically based atmosphere after Hillaire 2020 ("A Scalable and Production Ready Sky and
// Atmosphere Rendering Technique"): transmittance LUT, multiple-scattering LUT, sky-view LUT,
// plus a 2D aerial-perspective LUT specialised for sea-level surface points.
// Units: kilometres. Radiance is relative to a solar illuminance of 1.
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';
const params_mie = Number(new URLSearchParams(globalThis.location?.search || '').get('mie')) || 0;

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
  // alpha: optical depth in green; the other channels follow from the medium's spectral ratio
  oL = vec4(L, -log(max(T.g, 1e-4)));
}`;

export class Atmosphere {
  constructor(gl) {
    this.gl = gl;
    this.transmittance = new Texture(gl, { w: 256, h: 64, format: 'rgba16f' });
    this.multiScatter = new Texture(gl, { w: 32, h: 32, format: 'rgba16f' });
    this.skyView = new Texture(gl, { w: 256, h: 128, format: 'rgba16f' });
    this.aerialL = new Texture(gl, { w: 64, h: 64, format: 'rgba16f' });
    this.tTrans = new Target(gl, [this.transmittance]);
    this.tMS = new Target(gl, [this.multiScatter]);
    this.tSky = new Target(gl, [this.skyView]);
    this.tAerial = new Target(gl, [this.aerialL]);
    this.pTrans = new Program(gl, FULLSCREEN_VS, TRANSMITTANCE_FS, { label: 'atmo.trans' });
    this.pMS = new Program(gl, FULLSCREEN_VS, MULTISCATTER_FS, { label: 'atmo.ms' });
    this.pSky = new Program(gl, FULLSCREEN_VS, SKYVIEW_FS, { label: 'atmo.sky' });
    this.pAerial = new Program(gl, FULLSCREEN_VS, AERIAL_FS, { label: 'atmo.aerial' });
    this.maxDist = 60; // km
    this.key = '';
  }

  mediumUniforms(haze) {
    // haze: multiplier of sea-level aerosol density (marine boundary layer)
    // maritime aerosol: ~0.025/km at haze 1 (visibility ~100 km, AOD ~0.03); 'haze' scales it
    const mieScat = (params_mie || 0.025) * haze;
    const mieExt = mieScat / 0.9; // sea-salt aerosols are bright: single scattering albedo ~0.9
    const R = [5.802e-3, 13.558e-3, 33.1e-3];
    this.extRatio = R.map((r) => (r + mieExt) / (R[1] + mieExt));
    return {
      uRayleigh: R,
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
uniform sampler2D uTransmittance;
uniform vec3 uSunDir;
uniform float uAerialMax;
uniform vec3 uExtRatio;   // extinction of the sea-level medium relative to its green channel
uniform float uHazeSun;   // fraction of direct sun reaching the haze below the clouds
uniform sampler2D uIrradiance;
uniform float uCamHkm;
uniform float uLightScale; // radiometric scale of the light source (kept at 1: fp16 buffers)
uniform float uLightMag;   // apparent magnitude of the light source: sun -26.74, full moon -12.7
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
  return texture(uSkyView, vec2(az, v * 0.5 + 0.5)).rgb * uLightScale;
}
void aerial(vec3 d, float distKm, out vec3 L, out vec3 T) {
  vec2 h = sunBasisAz(d);
  float az = abs(atan(h.y, h.x)) / 3.14159265;
  vec2 uv = vec2(az, sqrt(clamp(distKm / uAerialMax, 0.0, 1.0)));
  vec4 al = texture(uAerialL, uv);
  L = al.rgb * uLightScale;
  T = exp(-al.a * uExtRatio);
  // under a cloud deck the haze is lit by diffuse light from the cloud base, not the sun. Per channel:
  // in an isotropic diffuse field the haze takes the field's own colour (no warm band at the horizon)
  vec3 ext = 1.0 - T;
  L = L * uHazeSun + ext * skyIrradiance() * (0.9 / (2.0 * 3.14159)) * (1.0 - uHazeSun);
}
vec3 transmittanceAt(float hKm, float mu) {
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
// illuminance of the light source (sun, or moon at night) at height hKm for direction cosine mu
vec3 sunTransmittanceAt(float hKm, float mu) { return transmittanceAt(hKm, mu) * uLightScale; }
vec3 sunIlluminance() { return sunTransmittanceAt(uCamHkm, uSunDir.y); }

// Night sky. Stars are points with physical flux (magnitude m -> 10^(-0.4 (m + 26.74)) of the
// sun), N(<m) ~ 10^(0.5 m) down to m = 6.5, spread over one pixel by a gaussian PSF, extinguished
// by the atmosphere and scintillating near the horizon. Against a daylight sky they vanish on
// their own; the Milky Way only shows on moonless nights, as in reality.
float starHash(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
vec3 starField(vec3 d, float pixelAngle, float time) {
  if (d.y < -0.01) return vec3(0.0);
  const float K = 150.0;
  vec3 p = d * K;
  vec3 base = floor(p - 0.5);
  vec3 acc = vec3(0.0);
  float sigma = pixelAngle * 0.75;
  for (int i = 0; i < 8; i++) {
    vec3 cell = base + vec3(float(i & 1), float((i >> 1) & 1), float((i >> 2) & 1));
    float h = starHash(cell);
    if (h > 0.14) continue;
    vec3 sp = normalize(cell + 0.15 + 0.7 * vec3(starHash(cell + 11.1), starHash(cell + 23.7), starHash(cell + 37.3)));
    // keep only stars whose projection stays in their own cell (the search covers +-1/2 cell)
    if (any(notEqual(floor(sp * K), cell))) continue;
    vec3 x = cross(sp, d);
    float ang2 = dot(x, x);
    if (ang2 > 36.0 * sigma * sigma) continue;
    float u = starHash(cell + 5.3);
    float m = 6.5 + 2.0 * log(max(u, 1e-5)) / log(10.0);
    float flux = pow(10.0, -0.4 * (m - uLightMag));
    float psf = exp(-0.5 * ang2 / (sigma * sigma)) / (6.2832 * sigma * sigma);
    float tcol = starHash(cell + 71.9);
    vec3 col = mix(vec3(1.0, 0.78, 0.55), vec3(0.78, 0.86, 1.0), smoothstep(0.1, 0.9, tcol));
    float twinkle = 1.0 + 0.55 * (starHash(cell + floor(time * 18.0)) - 0.5) * exp(-max(d.y, 0.0) * 12.0);
    acc += col * flux * psf * twinkle;
  }
  // Milky Way: a band of unresolved stars with dark dust lanes
  vec3 g = normalize(vec3(0.42, 0.55, -0.72));
  float b = dot(d, g);
  float band = exp(-b * b / 0.035);
  float n = starHash(floor(d * 60.0)) * 0.35 + 0.65;
  float dust = smoothstep(0.0, 0.08, abs(b + 0.03 * sin(d.x * 9.0 + d.z * 5.0)));
  acc += vec3(0.85, 0.88, 1.0) * band * n * mix(0.35, 1.0, dust) * 2.5e-10 * pow(10.0, 0.4 * (uLightMag + 26.74));
  return acc * transmittanceAt(0.0, max(d.y, 0.0));
}
// Rain / mist below the cloud deck: extinction uFogDensity (1/m) up to uFogTop (m).
// Lit by the diffuse sky/cloud light plus a forward-scattering sun lobe (droplets, g ~ 0.7).
uniform float uFogDensity;
uniform float uFogTop;
uniform vec3 uFlashFog;   // lightning light scattered by rain and mist
uniform vec3 uFlashDir;   // direction to the current lightning strike
vec3 fogRadiance(vec3 dir, float sunFrac) {
  float c = dot(dir, uSunDir);
  float g = 0.7;
  float ph = (1.0 - g * g) / (4.0 * 3.14159 * pow(1.0 + g * g - 2.0 * g * c, 1.5));
  // thick haze in a hemisphere-lit field: in-scatter -> albedo * E / (2 pi) (sky above, dark sea below)
  // lightning light scattered by rain and mist is concentrated towards the strike
  float fl = 0.2 + 2.2 * pow(max(dot(dir, uFlashDir), 0.0), 8.0);
  return skyIrradiance() * (0.92 / (2.0 * 3.14159)) + sunIlluminance() * sunFrac * ph * 0.92 + uFlashFog * fl;
}
float fogPathLength(vec3 dir, float dist) {
  // the veil only exists below the cloud base
  float toTop = dir.y > 0.0 ? uFogTop / max(dir.y, 0.015) : 1e9;
  return min(dist, toTop);
}
// Crepuscular rays: single scattering by the marine haze below the cloud base, with sun visibility
// taken from the cloud-shadow map (a point at height y sees the sun if the sea-level point it maps
// to along the sun direction does). Returns added radiance along the first dist metres.
uniform sampler2D uShaftShadow;
uniform vec4 uShaftRect;     // shadow map origin xz, 1/size
uniform vec4 uShaft;         // x: haze scattering (1/m), y: layer top (m), z: strength, w: jitter
vec3 shafts(vec3 ro, vec3 dir, float dist);
// Add crepuscular rays to a colour: lit gaps add sunlight; shadowed haze darkens what is there
// (hue-preserving: the removed in-scatter is the LUT's, whatever its colour), never below 20%.
vec3 withShafts(vec3 col, vec3 ro, vec3 dir, float dist) {
  vec3 sh = shafts(ro, dir, dist);
  float ds = dot(sh, vec3(0.2126, 0.7152, 0.0722));
  if (ds >= 0.0) return col + sh;
  float y = max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-7);
  return col * max(1.0 + ds / y, 0.2);
}
vec3 shafts(vec3 ro, vec3 dir, float dist) {
  if (uShaft.z <= 0.0 || uSunDir.y < 0.02) return vec3(0.0);
  float top = uShaft.y;
  float tMax = dist;
  if (dir.y > 0.0) tMax = min(tMax, (top - ro.y) / max(dir.y, 1e-3));
  tMax = min(tMax, 12000.0);
  if (tMax <= 0.0) return vec3(0.0);
  const int N = 28;
  float vis = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < N; i++) {
    // denser samples near the camera (quadratic), jittered per pixel
    float f = (float(i) + fract(uShaft.w + 52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))) / float(N);
    float t = tMax * f * f;
    vec3 p = ro + dir * t;
    vec2 xz0 = p.xz - uSunDir.xz * (max(p.y, 0.0) / uSunDir.y);
    float v = texture(uShaftShadow, (xz0 - uShaftRect.xy) * uShaftRect.zw).r;
    float w = 2.0 * f;          // dt for the quadratic distribution
    vis += v * w;
    wsum += w;
  }
  vis /= max(wsum, 1e-4);
  float c = dot(dir, uSunDir);
  float g = 0.76;
  float ph = (1.0 - g * g) / (4.0 * 3.14159 * pow(1.0 + g * g - 2.0 * g * c, 1.5));
  // only the deviation from the mean visibility adds contrast; the mean is already in the LUTs
  float trans = exp(-uShaft.x * tMax);
  return sunIlluminance() * uShaft.x * ph * (1.0 - trans) / max(uShaft.x, 1e-9) * (vis - uHazeSun) * uShaft.z;
}

// Squall front: rain curtains beyond the line dot(xz, n) = offset, ramping over +-width.
uniform vec4 uFogFront;   // xy normal (towards the storm), z offset (m), w width (0 = off)
uniform vec2 uFogStorm;   // storm-side extinction (1/m), storm-side brightness factor
float frontCurve(float along) { return 1400.0 * sin(along / 7000.0) + 650.0 * sin(along / 2900.0 + 1.3); }
uniform vec2 uFogCam;     // camera xz
// antiderivative of the linear ramp clamp((u + w) / 2w, 0, 1)
float rampInt(float u, float w) { return u < -w ? 0.0 : (u > w ? u : (u + w) * (u + w) / (4.0 * w)); }
float fogHash(float x) { return fract(sin(x * 91.17) * 43758.5453); }
float fogNoise(float x) { float i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f); return mix(fogHash(i), fogHash(i + 1.0), f); }
uniform vec2 uSprayHaze;  // x: extinction at the sea surface (1/m), y: camera height (m)
vec3 applyFog(vec3 col, vec3 dir, float dist) {
  float L = fogPathLength(dir, dist);
  float tau = uFogDensity * L;
  // wind-borne spray hugging the sea (scale height H ~ 20 m): integral of exp(-h/H) along the ray
  if (uSprayHaze.x > 0.0) {
    const float Hs = 20.0;
    float Ls = min(dist, 30000.0);
    float d = dir.y;
    float h0 = uSprayHaze.y;
    float I = abs(d) < 1e-4 ? exp(-h0 / Hs) * Ls : Hs / d * (exp(-h0 / Hs) - exp(-max(h0 + d * Ls, 0.0) / Hs));
    tau += uSprayHaze.x * max(I, 0.0);
  }
  float stormFrac = 0.0;
  if (uFogFront.w > 0.0) {
    vec2 n = uFogFront.xy;
    float w = uFogFront.w;
    float s0 = dot(uFogCam, n) - uFogFront.z;
    float a = dot(dir.xz, n);
    // meandering front: shift the line by its curve where this ray crosses it
    float tc0 = abs(a) > 1e-5 ? -s0 / a : 0.0;
    s0 -= frontCurve(dot(uFogCam + dir.xz * max(tc0, 0.0), vec2(-n.y, n.x)));
    float m = abs(a) < 1e-5 ? clamp((s0 + w) / (2.0 * w), 0.0, 1.0) * L : (rampInt(s0 + a * L, w) - rampInt(s0, w)) / a;
    // rain shafts: curtain density varies along the front where the ray crosses it
    float tc = abs(a) > 1e-5 ? -s0 / a : 0.0;
    vec2 xc = uFogCam + dir.xz * max(tc, 0.0);
    float along = dot(xc, vec2(-n.y, n.x));
    float shafts = 0.55 + 0.9 * fogNoise(along / 1700.0) * (0.6 + 0.4 * fogNoise(along / 430.0 + 7.0));
    // curtains fade out into the cloud base instead of ending at a ruler-straight line
    float hcr = max(dir.y * max(tc, 0.0), 0.0);
    float st = max(uFogStorm.x * shafts - uFogDensity, 0.0) * max(m, 0.0) * (1.0 - smoothstep(0.35 * uFogTop, uFogTop, hcr));
    tau += st;
    stormFrac = st / max(tau, 1e-6);
    // fine vertical streaks of falling rain, slanted by the wind, where the ray meets the curtain
    float hc = max(dir.y * max(tc, 0.0), 0.0);
    // fine streaks only up close; far curtains read as soft shafts (the fine detail is sub-pixel there)
    float near = 1.0 - smoothstep(3000.0, 12000.0, max(tc, 0.0));
    float streak = fogNoise(along / 900.0 + hc / 1400.0) * 0.6 + near * (fogNoise(along / 260.0 + hc / 500.0 + 3.0) * 0.28 + fogNoise(along / 85.0 + hc / 180.0 + 9.0) * 0.12) + (1.0 - near) * 0.2;
    // (far curtains: the streaks merge; only the broad shafts remain)
    stormFrac *= mix(0.88 + 0.2 * streak, 0.72 + 0.5 * streak, near);
  }
  float T = exp(-tau);
  // the storm's rain curtains stand in the storm's shadow: no direct sun, darker diffuse light
  float sf = clamp(stormFrac, 0.0, 1.0);
  return mix(mix(fogRadiance(dir, uHazeSun), fogRadiance(dir, 0.0) * uFogStorm.y, sf), col, T);
}
`;
