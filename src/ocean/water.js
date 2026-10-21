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
uniform float uSize[4];
uniform float uTexel[4];
uniform sampler2D uEnv;          // reflection environment (equirect, mips = roughness)
uniform float uUnresolved;       // unresolved mean square slope (Cox-Munk remainder)
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
  vec3 toCam = uCamPos - P;
  float dist = length(toCam);
  vec3 V = toCam / dist;

  // slopes and their variance from all cascades (hardware anisotropic + trilinear filtering)
  vec2 s = vec2(0.0);
  vec2 var = vec2(0.0);
// short-wave modulation: gust patches (cat's paws, ~100-300 m, drifting with the wind) and
  // hydrodynamic modulation (short waves steepen on the crests of the long waves)
  vec2 gq = vXZ - uGust.yz;
  float gust = gnoise(gq / 210.0) * 0.6 + gnoise(gq / 70.0 + 7.3) * 0.4;
  float crestM = smoothstep(-0.3 * uHs, 0.3 * uHs, vDisp);
  float sm = clamp((1.0 + uGust.x * (gust - 0.5) * 1.7) * mix(0.8, 1.25, crestM), 0.35, 1.9);
#define SLOPE(c, k) { vec4 m = texture(uSlope[c], vXZ / uSize[c]); s += m.xy * k; var += max(m.zw - m.xy * m.xy, vec2(0.0)) * k * k; }
  SLOPE(0, 1.0) SLOPE(1, 1.0) SLOPE(2, sm) SLOPE(3, sm)
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
    foamRaw = d0.w * 0.32 + d1.w * 1.0 + d2.w * 0.75;
    // waves break on the crests of the energetic (dominant) waves: whitecaps cluster there
    float crest = smoothstep(-0.2 * uHs, 0.3 * uHs, vDisp);
    foamRaw *= mix(0.65, 1.3, crest);
    activeRaw = textureGrad(uActive, u1, dFdx(u1) * 2.0, dFdy(u1) * 2.0).r * 1.3;
    activeRaw *= mix(0.6, 1.35, crest);
    // bubble plume: the same foam fields blurred over a few metres (bubbles spread and sink)
    vec4 b1 = texture(uDisp[1], u1, 1.2);
    plume = clamp(b1.w * mix(0.5, 1.3, crest), 0.0, 2.0);
  }

  // rain ripples: normal perturbation near the camera, extra roughness further away
  vec3 rr = rainRipples(vXZ, uTime, uRain, dist);
  s += rr.xy;
  // unresolved capillary roughness: sparkles near the camera, smooth BRDF lobe far away
  float unres = uUnresolved * 0.5 * mix(0.35, 1.0, smoothstep(4.0, 400.0, dist)) * sm * sm;
  vec2 sigmaSq = var + vec2(unres) + vec2(rr.z);
  sigmaSq = max(sigmaSq, vec2(2e-5));

  vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
  // specular anti-aliasing (Kaplanyan & Hoffman 2016): normal variation inside the pixel
  // footprint becomes extra slope variance, so sub-pixel ripples don't alias into hairlines
  vec3 dNx = dFdx(N), dNy = dFdy(N);
  float kv = min(0.5 * (dot(dNx, dNx) + dot(dNy, dNy)), 0.08);
  sigmaSq += vec2(kv);
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
  // a ray reflected downwards hits another wave: it sees a second, dimmer reflection of the
  // sky near the horizon rather than the sky above (mirroring it up gives bright crest lines).
  // The reflected lobe has an angular width ~2 sigma: blend by the fraction below the horizon,
  // which avoids binary per-pixel dashes where R.y changes sign.
  float lobe = 2.0 * sqrt(sigmaSq.x + sigmaSq.y) + 0.02;
  float below = smoothstep(-lobe, lobe, -R.y);
  R.y = abs(R.y) * mix(1.0, 0.15, below);
  // extended sources (sky, clouds) are blurred by the full capillary roughness; only the
  // sun's tiny disk is allowed to resolve into individual sparkles near the camera
  float rough = sqrt(sigmaSq.x + sigmaSq.y + uUnresolved * 0.65 * (1.0 - smoothstep(4.0, 400.0, dist)));
  // mip from the BRDF width and from the spread of reflected directions within the pixel
  float dR = length(fwidth(R));
  float envLod = clamp(max(log2(rough * 96.0), log2(dR * 256.0 / 3.14159) + 0.5), 0.0, 7.0);
  vec3 sky = envSample(R, envLod) * mix(1.0, 0.35, below);
  vec3 refl = F * sky;

  // sun glitter
  vec3 sun = uSunE * sunVis * reflectedSun(L, V, N, Tx, Ty, sigmaSq);

  // water-leaving radiance (deep, optically infinite water)
  vec3 Ed = uSunE * sunVis * max(L.y, 0.0) + uSkyE + uFlash * 0.3;
  vec3 body = uRrs * Ed * (1.0 - F) / 0.98;

  // crest subsurface scattering (light transmitted through thin backlit crests)
  float H = max(vDisp + 0.15 * uHs, 0.0) / max(uHs, 0.3);
  float back = pow(max(dot(L, -V), 0.0), 4.0) * pow(max(0.5 - 0.5 * dot(L, N), 0.0), 3.0);
  float side = pow(nv, 2.0) * 0.18;
  vec3 sss = uSSS * (1.0 - F) * (H * back * 3.0 * uSunE * sunVis + side * (uSkyE + uSunE * sunVis * max(L.y, 0.0) * 0.3));

  // submerged bubbles backscatter strongly: the water around and beneath whitecaps turns pale aquamarine
  float pl = (1.0 - exp(-plume * uFoamAmount * 1.8)) * (1.0 - smoothstep(150.0, 900.0, dist) * 0.6);
  body += (1.0 - F) * pl * vec3(0.02, 0.075, 0.07) * Ed / M_PI;
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
    vec3 Nf = normalize(vec3(-s.x * 0.5 + foamBump.x, 1.0, -s.y * 0.5 + foamBump.y));
    float wrapL = max((dot(Nf, L) + 0.35) / 1.35, 0.0);
    vec3 Ein = uSunE * sunVis * wrapL + uSkyE + uFlash;
    // bubble foam scatters like a diffuse white layer (albedo ~0.6-0.85); only its thinnest
    // parts let a little of the blue-green water show through
    float albedo = mix(0.6, 0.86, thick);
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
  col = max(col + shafts(uCamPos, -V, dist), vec3(0.0));
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
