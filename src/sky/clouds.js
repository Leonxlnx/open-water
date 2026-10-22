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
uniform float uCoverage;      // fair-weather side of the front
uniform float uBase;          // m
uniform float uTop;           // m
uniform float uDensity;       // extinction scale (1/m)
uniform float uDark;          // storm darkness 0..1
uniform vec4 uFront;          // squall front: xy unit normal (towards the storm), z offset (m), w width (0 = off)
uniform vec4 uStormA;         // storm side: coverage, darkness, density, base
uniform float uStormTop;      // storm side: top (m)
uniform float uShapeLod;      // debug: >= 0 forces the shape-noise mip level
uniform float uPixelAngle;    // radians per pixel of the pass (footprint for texture LOD)
uniform int uUpSteps;         // steps of the sky-light (upward) march through decks
// pixel footprint (m) at the current sample; set by the caller before density lookups
float gFoot = 0.0;
float lodFor(float texel) { return max(log2(max(gFoot, 1e-3) / texel), 0.0); }
uniform vec4 uFlash;          // lightning position xyz (m), intensity
uniform vec3 uFlashColor;
const float RG_M = 6360000.0;

float remapc(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }
// the squall line meanders (frontCurve is shared with the fog in SKY_LOOKUP_GLSL and the CPU)
float frontDist(vec2 xz) { return dot(xz, uFront.xy) - uFront.z - frontCurve(dot(xz, vec2(-uFront.y, uFront.x))); }
float frontMask(vec2 xz) { return uFront.w > 0.0 ? smoothstep(-uFront.w, uFront.w, frontDist(xz)) : 0.0; }
const float SCUD_BASE = 260.0;
float shellBase() {
  float b = uFront.w > 0.0 ? min(uBase, uStormA.w) : uBase;
  bool storm = uDark > 0.5 || (uFront.w > 0.0 && uStormA.y > 0.5);
  return storm ? min(b, SCUD_BASE) : b;
}
float shellTop() { return uFront.w > 0.0 ? max(uTop, uStormTop) : uTop; }
float maxCoverage() { return uFront.w > 0.0 ? max(uCoverage, uStormA.x) : uCoverage; }

// local cloud regime at a point: x coverage, y darkness, z density, w front mask; base/top out
// h: sample height. High up, the storm's anvil spreads ahead of the line (~3.5 km).
vec4 regime(vec2 xz, float h, out float base, out float top) {
  float anvil = smoothstep(uStormTop * 0.62, uStormTop * 0.86, h) * 3500.0;
  float m = 0.0, tv = 1.0;
  if (uFront.w > 0.0) {
    // the storm's face bulges forward and recedes by kilometres: convective towers, not a wall
    vec3 bp = vec3(xz.x + uWindOffset.x, h * 1.3, xz.y + uWindOffset.z) / 8500.0 + 0.77;
    vec4 bn = textureLod(uShape, bp, 2.0);
    vec4 bf = textureLod(uShape, bp * 3.1 + 0.29, 2.0);
    float bulge = ((bn.r * 0.7 + bn.g * 0.3 - 0.5) * 5500.0 + (bf.r - 0.5) * 1400.0) * smoothstep(300.0, 2500.0, h);
    tv = 0.7 + 0.3 * bn.g;
    m = smoothstep(-uFront.w, uFront.w, frontDist(xz) + anvil + bulge);
  }
  base = mix(uBase, uStormA.w, m);
  top = mix(uTop, uStormTop * tv, m);
  // the storm's coverage closes over the outer half of the ramp: its face has no see-through gaps
  // (and darkens just as fast: the storm's leading towers are part of one dark mass, not fair-weather cumulus)
  return vec4(mix(uCoverage, uStormA.x, smoothstep(0.0, 0.35, m)), mix(uDark, uStormA.y, smoothstep(0.0, 0.2, m)), mix(uDensity, uStormA.z, m), m);
}

// Shelf cloud (arcus): a low wedge along the gust front ahead of the rain. Its nose hangs lowest
// at the leading edge, the face steps up in laminar tiers and merges into the storm's base.
float shelfDensity(vec3 p, float h) {
  if (uFront.w <= 0.0 || uStormA.y < 0.5) return 0.0;
  float d = frontDist(p.xz);
  // the face leans back with height (~25 deg)
  float dl = d + (h - 260.0) * 2.2;
  if (dl < -3400.0 || d > 1600.0) return 0.0;
  float u = clamp((dl + 3400.0) / 5000.0, 0.0, 1.0);
  vec3 sp = (p + vec3(uWindOffset.x, 0.0, uWindOffset.z)) / vec3(2400.0, 700.0, 2400.0);
  vec4 n = textureLod(uShape, sp, lodFor(2400.0 / 128.0));
  // ragged, lumpy underside
  float sb = mix(260.0, uStormA.w, smoothstep(0.1, 0.95, u)) + (n.b - 0.5) * 160.0;
  float st = uStormA.w + 450.0;
  if (h < sb || h > st) return 0.0;
  float tz = (h - sb) / max(st - sb, 1.0);
  // turbulent lumps at ~150-300 m on the face
  vec4 n2 = textureLod(uShape, (p + vec3(uWindOffset.x, 0.0, uWindOffset.z)) / vec3(700.0, 300.0, 700.0) + 0.31, lodFor(700.0 / 128.0));
  // laminar rolls parallel to the gust front, varying along it
  float along = dot(p.xz, vec2(-uFront.y, uFront.x));
  float tiers = mix(0.45, 1.0, smoothstep(0.3, 0.7, 0.5 + 0.5 * sin(h * 0.042 + n.g * 0.8 + along / 900.0)));
  tiers = mix(1.0, tiers, smoothstep(0.2, 0.35, tz));
  tiers *= smoothstep(0.2, 0.55, n.r * 0.55 + n2.r * 0.55);
  float nose = smoothstep(0.0, 0.05 + 0.08 * n.r, u);
  float body = smoothstep(0.0, 0.1, tz) * (1.0 - smoothstep(0.75, 1.0, tz));
  // (seen from far off, below the storm's base, the wedge would read as flat slabs on the horizon)
  float far = 1.0 - smoothstep(10000.0, 18000.0, gFoot / max(uPixelAngle, 1e-6));
  return nose * body * tiers * smoothstep(0.3, 0.62, n.r * 0.75 + 0.4) * uStormA.z * 3.0 * far;
}

float cloudDensityR(vec3 p, float h, bool detail, vec4 R, float base, float top) {
  float shelf = shelfDensity(p, h);
  if (shelf > 0.0 && h < base) return shelf;
  // scud (fractus): ragged low fragments racing under a storm deck
  if (h < base) {
    float sg = uFront.w > 0.0 ? smoothstep(0.5, 0.85, R.w) * (1.0 - smoothstep(5000.0, 9000.0, frontDist(p.xz))) : step(0.5, R.y);
    if (sg <= 0.0 || h < SCUD_BASE) return 0.0;
    vec3 sp2 = (p + vec3(uWindOffset.x, 0.0, uWindOffset.z) * 1.8) / vec3(1400.0, 500.0, 1400.0);
    vec4 n2 = textureLod(uShape, sp2, lodFor(1400.0 / 128.0));
    float sb = SCUD_BASE + n2.b * 300.0;
    float sh = (h - sb) / max(base - sb, 1.0);
    if (sh <= 0.0) return 0.0;
    float frag = n2.r * 0.7 + n2.g * 0.3;
    float d2 = smoothstep(0.6, 0.9, frag) * (0.4 + 0.6 * n2.b) * smoothstep(0.0, 0.35, sh) * (1.0 - smoothstep(0.55, 1.0, sh));
    // (a near-field feature: at the horizon it would read as flat slabs under the storm)
    d2 *= 1.0 - smoothstep(9000.0, 16000.0, gFoot / max(uPixelAngle, 1e-6));
    return d2 * R.z * sg * 0.5;
  }
  if (h > top) return shelf;
  float hf = (h - base) / (top - base);
  float cov = R.x, dark = R.y;
  vec2 wuv = (p.xz + uWindOffset.xz) / 30000.0;
  vec4 wm = textureLod(uWeather, wuv, lodFor(30000.0 / 512.0));
  float c = smoothstep(1.0 - cov - 0.18, 1.0 - cov + 0.2, wm.r * 0.85 + wm.b * 0.25 * cov);
  // an overcast deck is closed: no column-shaped gaps from the 2D coverage map
  c = max(c, smoothstep(0.82, 0.96, cov));
  if (c <= 0.001) return shelf;
  // shape noise: ~350 m billows for cumulus, ~750 m cells for storm decks (blended in between)
  vec3 wo = vec3(uWindOffset.x, 0.0, uWindOffset.z);
  vec4 n = textureLod(uShape, (p + wo) / 3000.0, uShapeLod < 0.0 ? lodFor(3000.0 / 128.0) : uShapeLod);
  if (dark < 0.85) {
    vec4 nc = textureLod(uShape, (p + wo) / 1400.0 + 0.37, uShapeLod < 0.0 ? lodFor(1400.0 / 128.0) : uShapeLod);
    n = mix(nc, n, smoothstep(0.15, 0.85, dark));
  }
  float wf = n.g * 0.625 + n.b * 0.25 + n.a * 0.125;
  // vertical profile. Fair weather: cumulus towers with type-dependent tops.
  // Storm: a layer deck whose base undulates (rolls, scud) and whose thickness varies 2-3x,
  // which is what gives an overcast its mottled light and dark patches.
  // storm decks: a rolling, lumpy base
  float baseFrac = mix(0.0, ((wf - 0.45) * 400.0 + 60.0) / max(top - base, 100.0), dark);
  float topCu = mix(0.45, 1.0, wm.g);
  float cells = uFront.w > 0.0 ? smoothstep(0.35, 0.75, wm.b * 0.6 + sin(dot(p.xz, vec2(-uFront.y, uFront.x)) / 5200.0) * 0.25 + 0.3) : 0.0;
  float topSt = mix(0.18, 1.0, clamp(wm.b * 0.9 + n.r * 0.7 - 0.3 + cells * 0.6, 0.0, 1.0));
  // the anvil itself: a flat, smooth spreading layer near the top of the storm
  topSt = max(topSt, step(0.86, hf) * dark);
  // cumulus tops dome over the core of the coverage cell instead of a flat slab
  float tf = mix(topCu * mix(0.55, 1.0, smoothstep(0.0, 0.85, c)), topSt, dark);
  // per-cloud base height (flat bases that differ from cloud to cloud)
  baseFrac += (wm.g - 0.5) * 0.05 * (1.0 - dark);
  float hg = smoothstep(baseFrac, baseFrac + mix(110.0, 140.0, dark) / max(top - base, 100.0), hf) * (1.0 - smoothstep(tf * 0.55, tf, hf));
  bool anvilSlab = dark > 0.5 && hf > 0.8;
  if (anvilSlab) hg = smoothstep(baseFrac, baseFrac + 0.05, hf) * (1.0 - smoothstep(0.95, 1.0, hf));
  float shape = remapc(n.r, wf - 1.0, 1.0, 0.0, 1.0);
  if (R.w > 0.6 && hf < 0.8) shape = max(shape, 0.35 * smoothstep(0.6, 0.9, R.w));
  shape = max(shape, 0.45 * smoothstep(0.35, 0.8, c) * (1.0 - dark));
  float d = shape * hg;
  // the base of a cumulus is a little narrower than its body
  c *= mix(mix(0.8, 1.0, smoothstep(0.0, 0.12, hf)), 1.0, dark);
  // coverage erodes with height (Schneider 2017): the cloud narrows upward into turrets
  d = remapc(d, 1.0 - c * mix(1.0, 0.55, hf * (1.0 - dark)), 1.0, 0.0, 1.0) * c;
  if (d <= 0.0) return shelf;
  if (detail) {
    vec3 dp = (p + uWindOffset * vec3(1.15, 1.0, 1.15)) / 420.0;
    vec3 dn = textureLod(uDetail, dp, lodFor(420.0 / 32.0)).rgb;
    float df = dn.r * 0.625 + dn.g * 0.25 + dn.b * 0.125;
    // a finer octave (~140 m) for cauliflower lobes
    vec3 dn2 = textureLod(uDetail, dp * 3.0 + 0.41, lodFor(140.0 / 32.0)).rgb;
    // (only where it is resolved, and not on closed decks: no sub-pixel speckle, no cotton balls)
    float w2 = 0.3 * (1.0 - smoothstep(1.0, 2.0, lodFor(140.0 / 32.0))) * (1.0 - smoothstep(0.88, 0.97, cov));
    df = mix(df, dn2.r * 0.625 + dn2.g * 0.25 + dn2.b * 0.125, w2);
    // wispy at the base, billowy towards the tops
    // fair-weather cumulus are billowy everywhere; decks wispy at the base
    float dm = mix(1.0 - df, mix(df, 1.0 - df, clamp(hf * 5.0, 0.0, 1.0)), dark);
    float thr = dm * mix(0.55, 0.45, dark) * mix(1.0, 0.3, smoothstep(0.88, 0.97, cov)) * (anvilSlab ? 0.0 : 1.0);
    // (a fair-weather base is flat: the detail erodes it only a little)
    thr *= mix(mix(0.35, 1.0, smoothstep(0.02, 0.12, hf)), 1.0, dark);
    d = clamp(remapc(d, thr, thr + (1.0 - thr) * mix(0.25, 0.5, dark), 0.0, 1.0), 0.0, 1.0);
  }
  return max(max(d, 0.0) * R.z, shelf);
}
float cloudDensity(vec3 p, float h, bool detail) {
  float base, top;
  vec4 R = regime(p.xz, h, base, top);
  return cloudDensityR(p, h, detail, R, base, top);
}

// Fraction of the haze path (camera to distance md along rd) that is sunlit when a storm stands
// between the path and the sun: the storm's shadow reaches uStormTop / tan(elevation) ahead of the
// line, scaled by how much the sun stands behind the line. Skylight still scatters in the shadow.
float stormHazeLit(vec3 cam, vec3 rd, float md) {
  if (uFront.w <= 0.0 || uStormA.y < 0.5) return 1.0;
  vec2 sh = uSunDir.xz / max(length(uSunDir.xz), 1e-3);
  float tanE = max(uSunDir.y, 0.02) / max(length(uSunDir.xz), 1e-3);
  float reach = uStormTop / tanE * max(dot(sh, uFront.xy), 0.0);
  float fd0 = frontDist(cam.xz);
  float rate = dot(rd.xz, uFront.xy);
  // distance along the ray at which it enters the shadow (or never)
  float sEdge = fd0 >= -reach ? 0.0 : (rate > 1e-4 ? (-reach - fd0) / rate : 1e9);
  // the first 12 km are handled by the shadow-mapped crepuscular term (shafts) in the composite
  float tF = rate > 1e-4 ? max(-fd0 / rate, 0.0) : 1e9;
  float lit = 1.0 - max(md - min(max(sEdge, 12000.0), tF), 0.0) / max(md, 1.0);
  return mix(0.15, 1.0, lit);
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
vec4 marchClouds(vec3 ro, vec3 rd, int steps, int lightSteps, int lightDetail, float jitter, vec3 sunE, vec3 ambTop, vec3 ambBot, vec3 ambFace, out float meanDist) {
  meanDist = 0.0;
  if (maxCoverage() < 0.01) return vec4(0.0, 0.0, 0.0, 1.0);
  float sB = shellBase(), sT = shellTop();
  vec2 hb = shellHits(ro, rd, RG_M + sB);
  vec2 ht = shellHits(ro, rd, RG_M + sT);
  float t0, t1;
  float h0 = heightOf(ro);
  if (h0 < sB) {
    if (rd.y < -0.02) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = hb.y; t1 = ht.y;
  } else if (h0 < sT) {
    t0 = 0.0; t1 = rd.y > 0.0 ? ht.y : (hb.x > 0.0 ? hb.x : ht.y);
  } else {
    if (ht.x < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    t0 = ht.x; t1 = hb.x > 0.0 ? hb.x : ht.y;
  }
  t1 = min(t1, t0 + (uFront.w > 0.0 ? 120000.0 : 60000.0));
  if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
  // adaptive stepping: coarse probes in empty space, fine steps inside clouds.
  // Fine step grows with distance (pixel footprint) to bound the cost near the horizon.
  float fine = clamp(t0 * 0.008, 30.0, 700.0) * (64.0 / float(steps));
  float coarse = fine * 3.0;
  float t = t0 + coarse * jitter;
  vec3 L = vec3(0.0);
  float T = 1.0;
  float wsum = 0.0;
  float cosT = dot(rd, uSunDir);
  // multiple-scattering octaves (Wrenninge 2013): energy a^i, extinction b^i, eccentricity c^i
  float ph0 = mix(hg(cosT, 0.82), hg(cosT, -0.3), 0.4);
  float ph1 = mix(hg(cosT, 0.41), hg(cosT, -0.15), 0.5);
  float ph2 = mix(hg(cosT, 0.2), hg(cosT, -0.07), 0.5);
  float ph3 = mix(hg(cosT, 0.1), hg(cosT, -0.035), 0.5);
  bool inside = false;
  bool allowBack = true;
  float tEnter = 0.0, tDone = t0;
  int miss = 0;
  // (budget: a ray may cross a few near cumulus and still has to reach a storm 20+ km away)
  for (int i = 0; i < 320; i++) {
    if (i >= steps * 3 || T < 0.02 || t > t1) break;
    vec3 p = ro + rd * t;
    gFoot = t * uPixelAngle;
    float h = heightOf(p);
    float base, top;
    vec4 R = regime(p.xz, h, base, top);
    if (!inside) {
      // a probe that hits steps back one stride at every entry: the cloud's near edge is not skipped
      float stride = clamp(t * 0.02, coarse, max(coarse, 600.0));
      if (cloudDensityR(p, h, false, R, base, top) > 0.0) {
        inside = true; miss = 0;
        // (fine steps restart at a jittered phase: a back-step clamped to the shell entry would
        // otherwise put every pixel's samples at the same depths, printing contour bands)
        if (allowBack) { tEnter = t; t = max(t - stride, max(t0, tDone)) + fine * jitter; allowBack = false; continue; }
      } else { t += stride; continue; }
    }
    // distance LOD: erosion detail and long light paths are sub-pixel far away
    bool nearField = t * uPixelAngle < 25.0;
    float sigma = cloudDensityR(p, h, nearField, R, base, top);
    float stepLen = max(fine, min(max(t - 15000.0, 0.0) * 0.005, 150.0) * (64.0 / float(steps))) * (1.0 + t * 0.00004);
    if (sigma > 0.0) {
      miss = 0;
      float hf = clamp((h - base) / (top - base), 0.0, 1.0);
      // light march towards the sun (geometric step growth)
      float tau = 0.0;
      // far away the light path must still span the cloud (few long steps), or shading follows noise
      // the march spans the same ~2.6 km whatever the step count (env, far field, quality tier),
      // so coarse passes don't see thick decks as thin and sunlit inside
      int nL = (nearField || R.y > 0.5) ? lightSteps : 4;
      float lgrow = 2.0;
      float ls = 2600.0 / (exp2(float(nL)) - 1.0);
      vec3 lp = p;
      float marched = 0.0;
      bool exited = false;
      for (int j = 0; j < 8; j++) {
        if (j >= nL) break;
        lp += uSunDir * ls;
        float lh = heightOf(lp);
        if (lh > sT || lh < sB - 50.0) { exited = true; break; }
        tau += cloudDensity(lp, lh, j < lightDetail) * ls;
        marched += ls;
        ls *= lgrow;
      }
      // still inside a deck after 2.6 km: extrapolate the rest of the column with the mean density
      if (!exited && marched > 0.0) {
        float rest = clamp((top - heightOf(lp)) / max(uSunDir.y, 0.05), 0.0, 60000.0);
        tau += tau / marched * rest;
      }
      // scud sits under the deck: sunlight must cross the whole layer above it
      if (h < base) tau += R.z * (top - base) * 0.25 / max(uSunDir.y, 0.1);
      float msK = 1.0 - exp(-(tau + sigma * 30.0));
      float ms = ph0 * exp(-tau) + msK * (0.7 * ph1 * exp(-0.5 * tau) + 0.49 * ph2 * exp(-0.25 * tau) + 0.343 * ph3 * exp(-0.125 * tau));
      // powder: in-scattering probability is low at cloud edges facing the light
      float powder = 1.0 - exp(-2.0 * tau - sigma * 80.0);
      // optical depth of the column above: diffuse light filtering down through the deck
      float tauUp = 0.0;
      if (R.x > 0.55) {
        float us = 180.0, marchedUp = 0.0, uhLast = h;
        vec3 up = p;
        for (int j = 0; j < 4; j++) {
          if (j >= uUpSteps) break;
          up.y += us;
          float uh = heightOf(up);
          if (uh > top) break;
          tauUp += cloudDensityR(up, uh, false, R, base, top) * us;
          marchedUp += us; uhLast = uh;
          us *= uUpSteps < 3 ? 4.5 : 2.4;
        }
        if (R.y > 0.5 && marchedUp > 0.0) tauUp += tauUp / marchedUp * max(top - uhLast, 0.0);
      } else {
        tauUp = sigma * (1.0 - hf) * (top - base) * 0.35;
      }
      // two-stream diffusion transmittance for thick media (asymmetry g ~ 0.85): 1/(1 + 0.75(1-g) tau)
      float diffSun = 1.0 / (1.0 + 0.11 * tau);
      float diffUp = 1.0 / (1.0 + 0.11 * tauUp);
      // multiply scattered sunlight fills thick clouds with near-isotropic light, L ~ E T_diff / pi;
      // it dominates their shaded interiors (grey-white), not the blue skylight
      // (a deck is a slab lit from above: E mu0 T_d / pi; an isolated cumulus is lit on its sunward side)
      float slab = smoothstep(0.75, 0.95, R.x);
      // isolated cumulus: bright when seen from the sunlit side, dark bodies with bright rims backlit
      float diffuse = diffSun * mix(mix(0.12, 0.5, 1.0 - smoothstep(-0.6, 0.3, cosT)), max(uSunDir.y, 0.0) / 3.14159, slab) * (1.0 - exp(-0.15 * tau));
      // the diffused light carries the colour of the whole illumination at the cloud top: sun + skylight
      // diffused deck light mixes sun and blue skylight: neutral-cool (~6500 K) at the sun's luminance
      vec3 diffCol = dot(sunE, vec3(0.2126, 0.7152, 0.0722)) * vec3(0.93, 1.0, 1.09);
      vec3 sun = sunE * ms * mix(1.0, powder, 0.25 * (1.0 - max(cosT, 0.0))) + diffCol * diffuse;
      vec3 amb = ambTop * diffUp * mix(0.6, 1.0, hf) + ambBot * (1.0 - hf) * diffUp * 0.6;
      // the face toward the camera reflects the sky/sea light behind the camera where the column
      // above no longer lets skylight through
      // (a storm face: its shadowed sides fall to ~30% of the sunlit side)
      amb += ambFace * (1.0 - diffUp) * smoothstep(0.5, 0.9, R.x) * mix(1.0, 0.55, R.w) * mix(1.0, smoothstep(0.03, 0.25, hf), step(0.5, R.y)) * mix(1.0, 0.4, step(0.5, R.y) * R.w);
      if (h < base) amb *= 0.3; // scud: fragments in the deck's shade read darker than the deck
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
    } else if (t > tEnter && ++miss > 5) {
      inside = false; allowBack = true; tDone = t;
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
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oD;   // mean distance of the cloud light (km)
uniform sampler2D uHistoryD;
uniform mat4 uInvViewProj;
uniform mat4 uPrevViewProj;
uniform vec3 uCamPos;
uniform sampler2D uHistory;
uniform float uFrame;
uniform float uBlend;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform int uSteps;
uniform int uLightSteps;
uniform int uLightDetail;
uniform int uCheck;   // 1: raymarch one pixel of every 2x2 block per frame, reproject the rest
uniform vec3 uPrevWindOffset;
float jhash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  vec3 rd = normalize(w.xyz / w.w - uCamPos);
  // clouds are effectively at infinity: reproject by direction
  vec4 prevClip = uPrevViewProj * vec4(uCamPos + rd * 1e4, 1.0);
  vec2 puv = prevClip.xy / prevClip.w * 0.5 + 0.5;
  vec2 bord = 1.0 / vec2(textureSize(uHistory, 0));
  bool valid = prevClip.w > 0.0 && all(greaterThanEqual(puv, bord)) && all(lessThanEqual(puv, 1.0 - bord)) && uBlend < 1.0;
  vec4 hist = valid ? texture(uHistory, puv) : vec4(0.0);
  float histD = valid ? texture(uHistoryD, puv).r : 0.0;
  ivec2 ip = ivec2(gl_FragCoord.xy);
  int slot = (ip.x & 1) + 2 * (ip.y & 1);
  if (uCheck == 1 && valid && uBlend < 0.5 && slot != (int(uFrame) & 3)) { o = hist; oD = vec4(histD); return; }
  // jitter: a golden-ratio sequence in time from a random offset per pixel (stratified in time, no
  // spatial pattern: a low-discrepancy pattern in space, IGN, leaves a crosshatch no photograph has)
  float j = fract(jhash(vec3(gl_FragCoord.xy, 17.0)) + uFrame * 0.618034);
  float hKm = max(uBase, 0.0) * 0.001;
  vec3 sunE = sunTransmittanceAt(hKm + 0.5, uSunDir.y);
  vec3 zen = skyRadiance(vec3(0.0, 1.0, 0.0));
  vec3 hor = skyRadiance(normalize(vec3(uSunDir.z, 0.15, -uSunDir.x)));
  vec3 ambTop = (zen * 0.55 + hor * 0.45) * uAmbTop;
  vec3 ambBot = (sunTransmittanceAt(0.0, uSunDir.y) * max(uSunDir.y, 0.0) + zen * 3.14159) * 0.06 / 3.14159 * uAmbBot;
  float md;
  // light of the sky and sea behind the camera (mean radiance of the actual, clouded sky)
  vec3 ambFace = skyIrradiance() / 3.14159 * 0.45 * uAmbTop;
  vec4 c = marchClouds(uCamPos, rd, uSteps, uLightSteps, uLightDetail, j, sunE, ambTop, ambBot, ambFace, md);
  // aerial perspective toward the cloud
  if (c.a < 0.999) {
    vec3 aL, aT;
    aerial(rd, md * 0.001, aL, aT);
    // the aerial table holds horizontal sea-level paths; a raised cloud is seen through less haze:
    // scale the optical depth by the slant-path factor of the boundary layer (H ~ 2 km)
    float sEl = max(rd.y, 0.0) * md * 0.001 / 2.0;
    float fsl = sEl > 1e-3 ? (1.0 - exp(-sEl)) / sEl : 1.0;
    vec3 aT2 = pow(max(aT, vec3(1e-4)), vec3(fsl));
    aL *= (1.0 - aT2) / max(1.0 - aT, vec3(1e-4));
    aT = aT2;
    aL *= stormHazeLit(uCamPos, rd, md);
    c.rgb = c.rgb * aT + aL * (1.0 - c.a) * 0.9;
  }
  // the clouds drift with the wind aloft (their noise is sampled at p + windOffset): the cloud now at
  // X was at X + dWind a frame ago. Refetch the history there (the camera's own motion included).
  if (uCheck == 0 && c.a < 0.999 && uBlend < 1.0) {
    vec3 X = uCamPos + rd * md + vec3(uWindOffset.x - uPrevWindOffset.x, 0.0, uWindOffset.z - uPrevWindOffset.z);
    vec4 pc = uPrevViewProj * vec4(X, 1.0);
    vec2 pu = pc.xy / pc.w * 0.5 + 0.5;
    valid = pc.w > 0.0 && all(greaterThanEqual(pu, bord)) && all(lessThanEqual(pu, 1.0 - bord));
    if (valid) { hist = texture(uHistory, pu); histD = texture(uHistoryD, pu).r; }
  }
  // temporal accumulation (a checkerboarded pixel is refreshed every 4th frame: blend harder)
  float dk = md * 0.001;
  if (valid) {
    float bl = uCheck == 1 ? min(uBlend * 2.5, 1.0) : uBlend;
    c = mix(hist, c, bl);
    dk = mix(histD, dk, bl);
  }
  o = c;
  oD = vec4(dk);
}`;

const ENV_FS = SKY_LOOKUP_GLSL + CLOUD_GLSL + `
in vec2 vUv;
out vec4 o;
uniform vec3 uCamPos;
uniform vec3 uAmbTop;
uniform vec3 uAmbBot;
uniform float uFrame;
uniform sampler2D uHistory;
float jhash(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * 3.14159265;
  float theta = vUv.y * 3.14159265;
  vec3 rd = vec3(cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  if (rd.y < 0.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  rd = normalize(rd + vec3(0.0, 0.002, 0.0));
  // jitter: a golden-ratio sequence in time from a random offset per pixel (stratified in time, no
  // spatial pattern: a low-discrepancy pattern in space, IGN, leaves a crosshatch no photograph has)
  float j = fract(jhash(vec3(gl_FragCoord.xy, 17.0)) + uFrame * 0.618034);
  vec3 sunE = sunTransmittanceAt(uBase * 0.001 + 0.5, uSunDir.y);
  vec3 zen = skyRadiance(vec3(0.0, 1.0, 0.0));
  vec3 hor = skyRadiance(normalize(vec3(uSunDir.z, 0.15, -uSunDir.x)));
  vec3 ambTop = (zen * 0.55 + hor * 0.45) * uAmbTop;
  vec3 ambBot = (sunTransmittanceAt(0.0, uSunDir.y) * max(uSunDir.y, 0.0) + zen * 3.14159) * 0.06 / 3.14159 * uAmbBot;
  float md;
  // light of the sky and sea behind the camera (mean radiance of the actual, clouded sky)
  vec3 ambFace = skyIrradiance() / 3.14159 * 0.45 * uAmbTop;
  vec4 c = marchClouds(uCamPos, rd, 36, 3, 0, j, sunE, ambTop, ambBot, ambFace, md);
  if (c.a < 0.999) {
    vec3 aL, aT;
    aerial(rd, md * 0.001, aL, aT);
    // the aerial table holds horizontal sea-level paths; a raised cloud is seen through less haze:
    // scale the optical depth by the slant-path factor of the boundary layer (H ~ 2 km)
    float sEl = max(rd.y, 0.0) * md * 0.001 / 2.0;
    float fsl = sEl > 1e-3 ? (1.0 - exp(-sEl)) / sEl : 1.0;
    vec3 aT2 = pow(max(aT, vec3(1e-4)), vec3(fsl));
    aL *= (1.0 - aT2) / max(1.0 - aT, vec3(1e-4));
    aT = aT2;
    aL *= stormHazeLit(uCamPos, rd, md);
    c.rgb = c.rgb * aT + aL * (1.0 - c.a) * 0.9;
  }
  vec4 h = texture(uHistory, vUv);
  o = mix(h, c, uFrame < 1.5 ? 1.0 : 0.25);
}`;

const SHADOW_FS = 'uniform vec3 uSunDir;\nfloat frontCurve(float along) { return 1400.0 * sin(along / 7000.0) + 650.0 * sin(along / 2900.0 + 1.3); }\n' + CLOUD_GLSL + `
in vec2 vUv;
out vec4 o;
uniform vec4 uRect; // origin xz, size
void main() {
  vec3 p0 = vec3(uRect.x + vUv.x * uRect.z, 0.0, uRect.y + vUv.y * uRect.z);
  vec3 L = normalize(vec3(uSunDir.x, max(uSunDir.y, 0.03), uSunDir.z));
  float tb = shellBase() / L.y, tt = shellTop() / L.y;
  float tau = 0.0;
  gFoot = uRect.z / 256.0;
  const int N = 16;
  float dt = (tt - tb) / float(N);
  for (int i = 0; i < N; i++) {
    vec3 p = p0 + L * (tb + (float(i) + 0.5) * dt);
    tau += cloudDensity(p, p.y, false) * dt;
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
    this.envTex = [0, 1].map(() => new Texture(gl, { w: 320, h: 160, format: 'rgba16f' }));
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

  resize(w, h, div = 2) {
    const gl = this.gl;
    const nw = Math.ceil(w / div), nh = Math.ceil(h / div);
    if (this.tex && nw === this.w && nh === this.h) return;
    if (this.targets) this.targets.forEach((t) => t.dispose(true));
    this.w = nw; this.h = nh;
    this.tex = [0, 1].map(() => new Texture(gl, { w: this.w, h: this.h, format: 'rgba16f' }));
    this.dtex = [0, 1].map(() => new Texture(gl, { w: this.w, h: this.h, format: 'r16f' }));
    this.targets = this.tex.map((t, i) => new Target(gl, [t, this.dtex[i]]));
    this.cur = 0;
    this.reset = true;
  }

  uniforms(u) {
    return {
      uShape: this.shape, uDetail: this.detail, uWeather: this.weatherMap,
      uWindOffset: u.windOffset, uCoverage: u.coverage, uBase: u.base, uTop: u.top,
      uDensity: u.density, uDark: u.dark, uFlash: u.flash, uFlashColor: u.flashColor,
      uShapeLod: u.shapeLod ?? -1, uFront: u.front || [1, 0, 0, 0], uStormA: u.stormA || [0, 0, 0, 0], uStormTop: u.stormTop || 0,
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
    const full = this.reset || this.frame < 4 || u.everyFrame;
    if (full || this.frame % 2 === 0 || !this.shadowRect) {
      fullscreen(gl, this.pShadow, { ...cu, uSunDir: skyU.uSunDir, uRect: [ox, oz, this.shadowSize, 0] }, this.shadowTarget);
      this.shadowRect = [ox, oz, 1 / this.shadowSize, 1 / this.shadowSize];
    }

    const amb = { uAmbTop: u.ambTop || [1, 1, 1], uAmbBot: u.ambBot || [1, 1, 1] };
    // reflection probe clouds (amortised via history blend)
    const en = 1 - this.envCur;
    if (full || this.frame % 2 === 1 || u.flash[3] > 0.01) {
    fullscreen(gl, this.pEnv, { ...skyU, ...cu, ...amb, uCamPos: cam.pos, uFrame: this.reset ? 0 : this.frame, uHistory: this.envTex[this.envCur], uPixelAngle: (2 * Math.PI) / this.envTex[0].w, uUpSteps: 2 }, this.envTargets[en]);
    this.envCur = en;
    }

    const next = 1 - this.cur;
    const screenU = {
      ...skyU, ...cu, ...amb,
      uInvViewProj: cam.inv, uPrevViewProj: this.prevVP || cam.vp, uCamPos: cam.pos,
      uHistory: this.tex[this.cur], uHistoryD: this.dtex[this.cur], uFrame: this.frame % 64, uBlend: this.reset ? 1 : u.blend ?? 0.2,
      uPrevWindOffset: this.prevWind || u.windOffset,
      uPixelAngle: (cam.fov || 0.75) / this.h, uUpSteps: u.upSteps ?? 4, uSteps: u.steps ?? 64, uLightSteps: u.lightSteps ?? 6, uLightDetail: u.lightDetail ?? 3, uCheck: u.check ? 1 : 0,
    };
    // a full-resolution march is drawn in strips, each flushed on its own: one long draw can exceed the
    // GPU driver's watchdog on integrated GPUs (a reset, or worse)
    const strips = this.h > 400 ? Math.ceil(this.h / 270) : 1;
    if (strips > 1) gl.enable(gl.SCISSOR_TEST);
    for (let s = 0; s < strips; s++) {
      const y0 = Math.floor((this.h * s) / strips), y1 = Math.floor((this.h * (s + 1)) / strips);
      if (strips > 1) gl.scissor(0, y0, this.w, y1 - y0);
      fullscreen(gl, this.pScreen, screenU, this.targets[next]);
      if (strips > 1) gl.flush();
    }
    if (strips > 1) gl.disable(gl.SCISSOR_TEST);
    this.cur = next;
    this.prevVP = cam.vp;
    this.prevWind = [...u.windOffset];
    this.reset = false;
  }

  get screen() { return this.tex[this.cur]; }
  get depth() { return this.dtex[this.cur]; }
  get env() { return this.envTex[this.envCur]; }
}
