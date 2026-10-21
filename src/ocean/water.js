// Ocean surface: camera-centred polar grid displaced by the FFT cascades, shaded with
// a slope-variance (LEAN / Bruneton 2010) Beckmann BRDF, physically based water-leaving
// radiance, crest subsurface scattering, foam and aerial perspective.
import { Program, makeMesh } from '../gl.js';
import { SKY_LOOKUP_GLSL } from '../sky/atmosphere.js';
import { FOAM_GLSL } from './foam.js';
import { RAIN_SURFACE_GLSL } from '../fx/ripples.js';

const VS = `
layout(location = 0) in vec2 aPolar; // radius (m), angle (rad)
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform sampler2D uDisp[3];
uniform float uSize[4];
uniform float uTexel[4];
uniform float uAngStep;
uniform float uDispScale;
out vec3 vWorld;
out vec2 vXZ;
out float vDisp;
void main() {
  float r = aPolar.x;
  vec2 xz = uCamPos.xz + vec2(cos(aPolar.y), sin(aPolar.y)) * r;
  // vertex spacing at this ring -> mip level per cascade (filters waves the mesh cannot carry)
  float spacing = max(r * uAngStep, 0.02);
  vec3 D = vec3(0.0);
  float lsp = log2(spacing * 1.5);
  D += textureLod(uDisp[0], xz / uSize[0], max(lsp - log2(uTexel[0]), 0.0)).xyz;
  D += textureLod(uDisp[1], xz / uSize[1], max(lsp - log2(uTexel[1]), 0.0)).xyz;
  D += textureLod(uDisp[2], xz / uSize[2], max(lsp - log2(uTexel[2]), 0.0)).xyz;
  D *= uDispScale;
  // fade displacement where the mesh is extremely coarse (far field)
  vec3 P = vec3(xz.x + D.x, D.y, xz.y + D.z);
  // earth curvature
  float dr = length(P.xz - uCamPos.xz);
  P.y -= dr * dr / (2.0 * 6360000.0);
  vWorld = P;
  vXZ = xz;
  vDisp = D.y;
  gl_Position = uViewProj * vec4(P, 1.0);
}`;

const FS = SKY_LOOKUP_GLSL + FOAM_GLSL + RAIN_SURFACE_GLSL + `
in vec3 vWorld;
in vec2 vXZ;
in float vDisp;
out vec4 oColor;
uniform vec3 uCamPos;
uniform sampler2D uDisp[3];
uniform sampler2D uSlope[4];
uniform sampler2D uActive;      // active breaking of the main whitecap cascade (117 m)
uniform sampler2D uActive0;     // active breaking of the dominant waves (1800 m cascade)
uniform float uSize[4];
uniform float uTexel[4];
uniform sampler2D uEnv;          // reflection environment (equirect, mips = roughness)
uniform float uUnresolved;       // unresolved mean square slope (Cox-Munk remainder)
uniform float uMssTotal;         // total mean square slope of the surface (Cox-Munk)
uniform float uLongSlope;        // rms slope of the dominant (1800 m cascade) waves
uniform float uGlintArea;        // area of a glinting capillary facet (m2)
uniform vec4 uBolt;              // ground strike: foot xz, channel top height, channel radiance (0: none)
uniform float uHs;
uniform vec3 uRrs;               // water-leaving remote sensing reflectance (1/sr)
uniform vec3 uSSS;               // crest scatter colour * strength
uniform float uFoamAmount;
uniform float uFoamLace;         // residual foam lace everywhere at gale force (stage-B whitecaps)
uniform float uTime;
uniform float uRain;
uniform vec3 uGust;              // x: gustiness 0..1, yz: downwind drift of the gust pattern (m)
float ghash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(ghash(i), ghash(i + vec2(1, 0)), f.x), mix(ghash(i + vec2(0, 1)), ghash(i + vec2(1, 1)), f.x), f.y);
}
uniform vec3 uFlash;             // lightning illuminance
uniform int uDebug;
uniform vec3 uDbgMask; // debug: reflection, sun, body multipliers

const float M_PI = 3.14159265359;

vec2 equirectUv(vec3 d) {
  return vec2(atan(d.z, d.x) / (2.0 * M_PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / M_PI);
}
vec3 envSample(vec3 d, float lod) {
  d.y = max(d.y, 0.0);
  return textureLod(uEnv, equirectUv(normalize(d)), lod).rgb;
}

// Bruneton et al. 2010 (after Ross et al. 2005), Beckmann with slope variance.
float erfc_(float x) { return 2.0 * exp(-x * x) / (2.319 * x + sqrt(4.0 + 1.52 * x * x)); }
float Lambda(float cosTheta, float sigmaSq) {
  float v = cosTheta / sqrt((1.0 - cosTheta * cosTheta) * (2.0 * sigmaSq));
  return max(0.0, (exp(-v * v) - v * sqrt(M_PI) * erfc_(v)) / (2.0 * v * sqrt(M_PI)));
}
float meanFresnel(float cosThetaV, float sigmaV) {
  return pow(max(1.0 - cosThetaV, 0.0), 5.0 * exp(-2.69 * sigmaV)) / (1.0 + 22.7 * pow(sigmaV, 1.5));
}
float reflectedSun(vec3 L, vec3 V, vec3 N, vec3 Tx, vec3 Ty, vec2 sigmaSq) {
  vec3 H = normalize(L + V);
  float zH = dot(H, N);
  if (zH <= 0.0) return 0.0;
  float zetax = dot(H, Tx) / zH;
  float zetay = dot(H, Ty) / zH;
  float zL = dot(L, N), zV = dot(V, N);
  float p = exp(-0.5 * (zetax * zetax / sigmaSq.x + zetay * zetay / sigmaSq.y)) / (2.0 * M_PI * sqrt(sigmaSq.x * sigmaSq.y));
  vec2 tv = vec2(dot(V, Tx), dot(V, Ty));
  float cosV2 = tv.x * tv.x / max(dot(tv, tv), 1e-12);
  float sigmaV2 = sigmaSq.x * cosV2 + sigmaSq.y * (1.0 - cosV2);
  vec2 tl = vec2(dot(L, Tx), dot(L, Ty));
  float cosL2 = tl.x * tl.x / max(dot(tl, tl), 1e-12);
  float sigmaL2 = sigmaSq.x * cosL2 + sigmaSq.y * (1.0 - cosL2);
  float fresnel = 0.02 + 0.98 * pow(max(1.0 - dot(V, H), 0.0), 5.0);
  zL = clamp(zL, 0.01, 0.9999);
  zV = clamp(zV, 0.01, 0.9999);
  return fresnel * p / ((1.0 + Lambda(zL, sigmaL2) + Lambda(zV, sigmaV2)) * zV * zH * zH * zH * zH * 4.0);
}

// C2-smooth bilinear (Quilez): remap the fractional texel position with a quintic
vec2 smoothUv(vec2 uv, float res) {
  vec2 x = uv * res + 0.5;
  vec2 i = floor(x), f = x - i;
  f = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return (i + f - 0.5) / res;
}

void main() {
  vec3 uSunE = sunIlluminance();
  vec3 uSkyE = skyIrradiance();
  vec3 P = vWorld;
  // area of the pixel footprint on the sea (m2)
  float footA = max(length(cross(dFdx(P), dFdy(P))), 1e-9);
  vec3 toCam = uCamPos - P;
  float dist = length(toCam);
  // footprint-aligned cells of about one pixel (for per-pixel random events: glints, impacts)
  vec2 ex = dFdx(vXZ), ey = dFdy(vXZ), qc = vXZ - uCamPos.xz;
  vec2 gCell = floor(vec2(dot(qc, ex) / max(dot(ex, ex), 1e-12), dot(qc, ey) / max(dot(ey, ey), 1e-12)));
  vec3 V = toCam / dist;

  // slopes and their variance from all cascades (hardware anisotropic + trilinear filtering)
  vec2 s = vec2(0.0);
  vec2 var = vec2(0.0);
// short-wave modulation: gust patches (cat's paws, ~100-300 m, drifting with the wind) and
  // hydrodynamic modulation (short waves steepen on the crests of the long waves)
  vec2 gq = vXZ - uGust.yz;
  float gust = gnoise(gq / 210.0) * 0.6 + gnoise(gq / 70.0 + 7.3) * 0.4;
  float crestM = smoothstep(-0.3 * uHs, 0.3 * uHs, vDisp);
#define SLOPE(c, k) { vec4 m = texture(uSlope[c], vXZ / uSize[c]); s += m.xy * k; var += max(m.zw - m.xy * m.xy, vec2(0.0)) * k * k; }
  SLOPE(0, 1.0)
  // the forward (downwind) faces of the dominant waves: steep short waves and breaking live there
  float face = smoothstep(0.0, 1.0, -dot(s, uWindDir) / max(uLongSlope, 0.01));
  float hm = clamp(0.6 * crestM + 0.4 * face, 0.0, 1.0);
  float sm = clamp((1.0 + uGust.x * (gust - 0.5) * 1.0) * mix(0.55, 1.6, hm), 0.35, 2.0);
  SLOPE(1, mix(1.0, sm, 0.5)) SLOPE(2, sm) SLOPE(3, sm)
  float foamRaw = 0.0;
  float plume = 0.0;
  float activeRaw = 0.0;
  {
    // quintic-smoothed lookups: thresholding a bilinear coarse field gives polygonal outlines
    // (explicit gradients: the remapped coordinates must not drive mip selection)
    vec2 u0 = vXZ / uSize[0], u1 = vXZ / uSize[1];
    vec4 d0 = textureGrad(uDisp[0], smoothUv(u0, uSize[0] / uTexel[0]), dFdx(u0) * 0.5, dFdy(u0) * 0.5);
    vec4 d1 = textureGrad(uDisp[1], smoothUv(u1, uSize[1] / uTexel[1]), dFdx(u1) * 0.5, dFdy(u1) * 0.5);
    vec4 d2 = texture(uDisp[2], vXZ / uSize[2]);
    foamRaw = d0.w * 0.15 + d1.w * 1.0 + d2.w * 0.75;
    // waves break on the crests of the energetic (dominant) waves: whitecaps cluster there
    float crest = smoothstep(-0.2 * uHs, 0.3 * uHs, vDisp);
    foamRaw *= mix(0.65, 1.3, crest);
    // (a soft density ramp: the bubble pattern, not the field's outline, shapes the cap)
    // (the crest moves downwind: a point collects the froth of crests now 1.5-5 m downwind of it)
    vec2 ga = dFdx(u1) * 1.6, gb = dFdy(u1) * 1.6, wo = uWindDir / uSize[1];
    float aT = textureGrad(uActive, u1, ga, gb).r + textureGrad(uActive, u1 + wo * 1.5, ga, gb).r * 0.8
             + textureGrad(uActive, u1 + wo * 3.0, ga, gb).r * 0.55 + textureGrad(uActive, u1 + wo * 5.0, ga, gb).r * 0.3;
    activeRaw = aT * 0.45 + textureGrad(uActive0, u0, dFdx(u0) * 1.2, dFdy(u0) * 1.2).r * 0.8;
    activeRaw *= mix(0.6, 1.35, crest) * mix(0.6, 1.4, face);
    // bubble plume: the same foam fields blurred over a few metres (bubbles spread and sink)
    // (it follows recent breaking: mostly the active field, a little of the old foam)
    vec4 b1 = texture(uDisp[1], u1, 2.5);
    float pa = textureLod(uActive, u1, 2.5).r;
    plume = clamp((pa * 1.5 + b1.w * 0.15) * mix(0.5, 1.3, crest), 0.0, 2.0);
  }

  // rain ripples: normal perturbation near the camera, extra roughness further away
  vec3 rr = rainRipples(vXZ, uTime, uRain, dist, sqrt(footA));
  s += rr.xy;
  // unresolved capillary roughness: sparkles near the camera, smooth BRDF lobe far away
  float unres = uUnresolved * 0.5 * sm * sm;
  vec2 sigmaSq = var + vec2(unres);
  sigmaSq = max(sigmaSq, vec2(2e-5));

  vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
  // specular anti-aliasing (Kaplanyan & Hoffman 2016): normal variation inside the pixel
  // footprint becomes extra slope variance, so sub-pixel ripples don't alias into hairlines
  vec3 dNx = dFdx(N), dNy = dFdy(N);
  float kv = min(0.5 * (dot(dNx, dNx) + dot(dNy, dNy)), 0.08);
  // the footprint cannot hold more slope variance than the whole surface has (Cox-Munk): beyond that
  // the glitter path would stop narrowing toward the horizon. Rain roughness comes on top.
  sigmaSq = min(sigmaSq + vec2(kv), vec2(0.5 * uMssTotal)) + vec2(rr.z);
  vec3 Ty = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 Tx = cross(Ty, N);

  vec3 L = uSunDir;
  float nv = clamp(dot(N, V), 0.0, 1.0);
  // view-direction slope variance for the averaged Fresnel
  vec2 vh = normalize(V.xz + 1e-6);
  float sigmaV = sqrt(dot(vh * vh, sigmaSq));
  float F = 0.02 + 0.98 * meanFresnel(nv, sigmaV);

  // sun visibility through clouds
  vec2 suv = (P.xz - uShaftRect.xy) * uShaftRect.zw;
  float sunVis = texture(uShaftShadow, suv).r;

  // reflection of the sky / clouds, blurred by the unresolved roughness
  vec3 R = reflect(-V, N);
  float dR = length(fwidth(R));
  vec3 Ed = uSunE * sunVis * max(L.y, 0.0) + uSkyE + uFlash * 0.3;
  // on a rough sea the facets we see lean toward us (Smith masking): the reflected rays rise
  R.y += 0.75 * sigmaV * (1.0 - nv);
  // a ray reflected downwards hits the next wave: it sees that wave's water and, reflected once
  // more, the sky about two rms slopes up (not the brightest band at the horizon). The lobe has
  // an angular width ~2 sigma: blend by the fraction below the horizon (no per-pixel dashes).
  float lobe = 2.0 * sqrt(sigmaSq.x + sigmaSq.y) + 0.02;
  float below = smoothstep(-lobe, lobe, -R.y);
  float s2 = sqrt(0.5 * (sigmaSq.x + sigmaSq.y));
  float F2 = 0.02 + 0.98 * pow(1.0 - clamp(abs(R.y) + s2, 0.0, 1.0), 5.0);
  R.y = abs(R.y) + below * 2.0 * s2;
  R = normalize(R);
  // extended sources (sky, clouds) are blurred by the full capillary roughness, except near the
  // camera where only the sun's tiny disk resolves into sparkles
  float rough = sqrt(max(sigmaSq.x + sigmaSq.y - 2.0 * unres * (1.0 - mix(0.35, 1.0, smoothstep(4.0, 400.0, dist))), 4e-5));
  // mip from the BRDF width and from the spread of reflected directions within the pixel
  float envLod = clamp(max(log2(rough * 96.0), log2(dR * 256.0 / 3.14159) + 0.5), 0.0, 7.0);
  vec3 sky = envSample(R, envLod) * mix(1.0, F2, below) + below * (1.0 - F2) * uRrs * Ed;
  vec3 refl = F * sky;
  // rain impact stipple where a single impact (crater + crown, ~2 cm2) is about pixel-sized: a
  // Poisson count of impacts within the ~60 ms they stay visible; craters see the lower sky
  // (darker), crowns catch the light (brighter)
  if (uRain > 0.01) {
    float pix = sqrt(footA);
    float vis = smoothstep(0.003, 0.006, pix) * (1.0 - smoothstep(0.15, 0.4, pix));
    if (vis > 0.0) {
      float lamI = 2600.0 * uRain * footA * 0.5;
      vec2 cell = gCell;
      float u1 = fract(sin(dot(vec3(cell, floor(uTime * 16.0)), vec3(12.9898, 78.233, 45.164))) * 43758.5453);
      float u2 = fract(u1 * 91.73 + 0.37);
      float pk = exp(-lamI), cdf = pk, k = 0.0;
      for (int i = 0; i < 12; i++) { if (u1 <= cdf) break; k += 1.0; pk *= lamI / k; cdf += pk; }
      float frac = min(2e-4 / footA, 1.0);
      refl *= 1.0 + clamp((k - lamI) * frac, -0.6, 1.0) * (u2 < 0.75 ? 0.7 : -0.2) * vis;
    }
  }

  // sun glitter
  vec3 sun = uSunE * sunVis * reflectedSun(L, V, N, Tx, Ty, sigmaSq);
  // Glints: the expected sun reflection is carried by a few capillary facets (~1 cm2) whose slopes
  // happen to mirror the sun's disk (6.8e-5 sr) into the eye. With N facets in the pixel footprint,
  // lambda = E[L] Omega_sun / (F L_sun) N glint on average: near the camera lambda << 1 (sparse,
  // full-brightness sparkles on dark water), far away it is large (the smooth glitter path).
  {
    vec3 Hs = normalize(L + V);
    float fH = 0.02 + 0.98 * pow(max(1.0 - dot(V, Hs), 0.0), 5.0);
    // (glinting capillary facets of a few cm2)
    float lam = dot(sun, vec3(0.2126, 0.7152, 0.0722)) / max(dot(uSunE * sunVis, vec3(0.2126, 0.7152, 0.0722)), 1e-9)
              * 6.8e-5 / fH * (footA / uGlintArea);
    if (lam > 1e-7 && lam < 400.0) {
      vec2 cell = gCell;
      float u = fract(sin(dot(vec3(cell, floor(uTime * 30.0)), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
      float k = 0.0;
      if (lam < 12.0) {
        // Poisson sample by inversion
        float pk = exp(-lam), cdf = pk;
        for (int i = 0; i < 24; i++) { if (u <= cdf) break; k += 1.0; pk *= lam / k; cdf += pk; }
      } else {
        // shot noise: Gaussian approximation
        float u2 = fract(u * 113.37 + 0.71);
        k = max(lam + sqrt(lam) * sqrt(-2.0 * log(max(u, 1e-6))) * cos(6.2831853 * u2), 0.0);
      }
      sun *= k / lam;
    }
  }

  // the lightning channel mirrored by the rough sea: a glitter column under the strike
  if (uBolt.w > 0.0) {
    vec2 toB = uBolt.xy - P.xz;
    float dh = max(length(toB), 1.0);
    vec2 rh = R.xz / max(length(R.xz), 1e-4);
    float ang = acos(clamp(dot(rh, toB / dh), -1.0, 1.0));
    // reflected directions spread by twice the facet slope spread
    float lobeW = max(2.0 * sqrt(0.5 * (sigmaSq.x + sigmaSq.y)), 3.0 / dh);
    float elev = R.y / max(length(R.xz), 1e-4);
    float span = smoothstep(-0.005, 0.01, elev) * (1.0 - smoothstep(0.7, 1.0, elev * dh / max(uBolt.z, 1.0)));
    // a channel ~2 m wide seen through a slope lobe of width lobeW: its radiance spreads over the lobe
    float spread = (2.0 / dh) / (lobeW * 2.5066);
    // (only the brightest part of the channel, near the sea, is not hidden by rain and cloud: ~3%)
    sun += F * vec3(0.82, 0.86, 1.0) * uBolt.w * 0.03 * exp(-ang * ang / (2.0 * lobeW * lobeW)) * span * min(spread, 1.0);
  }

  // water-leaving radiance (deep, optically infinite water)
  vec3 body = uRrs * Ed * (1.0 - F) / 0.98;

  // crest subsurface scattering (light transmitted through thin backlit crests)
  float H = max(vDisp + 0.15 * uHs, 0.0) / max(uHs, 0.3);
  // only thin, steep crests near enough to resolve transmit light
  float back = pow(max(dot(L, -V), 0.0), 4.0) * pow(max(0.5 - 0.5 * dot(L, N), 0.0), 3.0)
             * (1.0 - smoothstep(20.0, 200.0, dist)) * smoothstep(0.15, 0.35, length(s));
  float side = pow(nv, 2.0) * 0.18;
  vec3 sss = uSSS * (1.0 - F) * (H * back * 3.0 * uSunE * sunVis + side * (uSkyE + uSunE * sunVis * max(L.y, 0.0) * 0.3));

  // submerged bubbles backscatter strongly: the water around and beneath whitecaps turns pale aquamarine
  float pl = (1.0 - exp(-plume * uFoamAmount * 1.8)) * (1.0 - smoothstep(150.0, 900.0, dist) * 0.6);
  body += (1.0 - F) * pl * vec3(0.05, 0.09, 0.075) * Ed / M_PI;
  vec3 col = refl * uDbgMask.x + sun * uDbgMask.y + (body + sss) * uDbgMask.z;
  col += (1.0 - F) * uRain * 0.035 * smoothstep(3.0, 40.0, dist) * (uSkyE + uSunE * sunVis * max(L.y, 0.0)) / M_PI;

  // foam
  vec2 fc = foamCoverage(vXZ, foamRaw * uFoamAmount, uFoamLace * uFoamAmount, activeRaw * uFoamAmount, dist);
  float foam = fc.x;
  if (uDebug == 1) { oColor = vec4(foam, foamRaw, 0.0, 1.0); return; }
  if (foam > 0.0) {
    // bubble layer: thick fresh foam is a bright diffuse scatterer (albedo ~0.8);
    // thin residual foam is translucent and picks up the water's blue-green
    float thick = fc.y;
    vec3 Nf = normalize(vec3(-s.x * 0.5 + foamBump.x * 1.8, 1.0, -s.y * 0.5 + foamBump.y * 1.8));
    float wrapL = max((dot(Nf, L) + 0.35) / 1.35, 0.0);
    vec3 Ein = uSunE * sunVis * wrapL + uSkyE * (0.45 + 0.55 * Nf.y) + uFlash;
    // bubble foam scatters like a diffuse white layer (albedo ~0.6-0.85); only its thinnest
    // parts let a little of the blue-green water show through
    float albedo = mix(0.3, 0.86, thick);
    vec3 tint = mix(vec3(0.82, 0.93, 0.95), vec3(1.0), thick);
    vec3 foamCol = albedo * tint * Ein / M_PI;
    col = mix(col, foamCol, foam);
  }

  // lightning reflection (broad, from cloud base)
  col += F * uFlash * 0.08;

  // aerial perspective
  vec3 dir = -V;
  vec3 aL, aT;
  aerial(dir, dist * 0.001, aL, aT);
  col = col * aT + aL;
  // light shafts through cloud gaps in the haze between the camera and this point
  col = withShafts(col, uCamPos, -V, dist);
  // rain / mist fog
  col = applyFog(col, -V, dist);
  oColor = vec4(col, 1.0);
}`;

export class Water {
  constructor(gl, { angular = 512, center = 0.03, far = 40000 } = {}) {
    this.gl = gl;
    this.prog = new Program(gl, VS, FS, { label: 'water' });
    const ang = (2 * Math.PI) / angular;
    const q = 1 + ang;
    const a = center / ang;
    const radii = [0];
    const rings = Math.ceil(Math.log(far / a + 1) / Math.log(q));
    for (let i = 1; i <= rings; i++) {
      const r = a * (Math.pow(q, i) - 1);
      radii.push(r);
      if (r > far) break;
    }
    const nr = radii.length;
    const verts = new Float32Array(nr * (angular + 1) * 2);
    let o = 0;
    for (let i = 0; i < nr; i++)
      for (let j = 0; j <= angular; j++) { verts[o++] = radii[i]; verts[o++] = j * ang; }
    const idx = new Uint32Array((nr - 1) * angular * 6);
    o = 0;
    for (let i = 0; i < nr - 1; i++)
      for (let j = 0; j < angular; j++) {
        const a0 = i * (angular + 1) + j, a1 = a0 + 1, b0 = a0 + angular + 1, b1 = b0 + 1;
        idx[o++] = a0; idx[o++] = b0; idx[o++] = a1;
        idx[o++] = a1; idx[o++] = b0; idx[o++] = b1;
      }
    this.mesh = makeMesh(gl, [[verts, 2]], idx);
    this.angStep = ang;
  }

  draw(uniforms) {
    const gl = this.gl;
    this.prog.use({ ...uniforms, uAngStep: this.angStep });
    gl.bindVertexArray(this.mesh.vao);
    gl.drawElements(gl.TRIANGLES, this.mesh.count, this.mesh.itype, 0);
    gl.bindVertexArray(null);
  }
}
