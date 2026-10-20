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
  float lsp = log2(spacing * 1.5 * 256.0);
  D += textureLod(uDisp[0], xz / uSize[0], max(lsp - log2(uSize[0]), 0.0)).xyz;
  D += textureLod(uDisp[1], xz / uSize[1], max(lsp - log2(uSize[1]), 0.0)).xyz;
  D += textureLod(uDisp[2], xz / uSize[2], max(lsp - log2(uSize[2]), 0.0)).xyz;
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
uniform float uSize[4];
uniform sampler2D uEnv;          // reflection environment (equirect, mips = roughness)
uniform sampler2D uCloudShadow;  // sun visibility on the sea plane
uniform vec4 uShadowRect;        // xz origin, 1/size
uniform float uUnresolved;       // unresolved mean square slope (Cox-Munk remainder)
uniform float uHs;
uniform vec3 uRrs;               // water-leaving remote sensing reflectance (1/sr)
uniform vec3 uSSS;               // crest scatter colour * strength
uniform float uFoamAmount;
uniform float uTime;
uniform float uRain;
uniform vec3 uFlash;             // lightning illuminance
uniform int uDebug;

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
  return pow(1.0 - cosThetaV, 5.0 * exp(-2.69 * sigmaV)) / (1.0 + 22.7 * pow(sigmaV, 1.5));
}
float reflectedSun(vec3 L, vec3 V, vec3 N, vec3 Tx, vec3 Ty, vec2 sigmaSq) {
  vec3 H = normalize(L + V);
  float zH = dot(H, N);
  if (zH <= 0.0) return 0.0;
  float zetax = dot(H, Tx) / zH;
  float zetay = dot(H, Ty) / zH;
  float zL = dot(L, N), zV = dot(V, N);
  float p = exp(-0.5 * (zetax * zetax / sigmaSq.x + zetay * zetay / sigmaSq.y)) / (2.0 * M_PI * sqrt(sigmaSq.x * sigmaSq.y));
  float tanV = atan(dot(V, Ty), dot(V, Tx));
  float cosV2 = 1.0 / (1.0 + tanV * tanV);
  float sigmaV2 = sigmaSq.x * cosV2 + sigmaSq.y * (1.0 - cosV2);
  float tanL = atan(dot(L, Ty), dot(L, Tx));
  float cosL2 = 1.0 / (1.0 + tanL * tanL);
  float sigmaL2 = sigmaSq.x * cosL2 + sigmaSq.y * (1.0 - cosL2);
  float fresnel = 0.02 + 0.98 * pow(1.0 - dot(V, H), 5.0);
  zL = max(zL, 0.01);
  zV = max(zV, 0.01);
  return fresnel * p / ((1.0 + Lambda(zL, sigmaL2) + Lambda(zV, sigmaV2)) * zV * zH * zH * zH * zH * 4.0);
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
#define SLOPE(c) { vec4 m = texture(uSlope[c], vXZ / uSize[c]); s += m.xy; var += max(m.zw - m.xy * m.xy, vec2(0.0)); }
  SLOPE(0) SLOPE(1) SLOPE(2) SLOPE(3)
  float foamRaw = 0.0;
  {
    vec4 d0 = texture(uDisp[0], vXZ / uSize[0]);
    vec4 d1 = texture(uDisp[1], vXZ / uSize[1]);
    vec4 d2 = texture(uDisp[2], vXZ / uSize[2]);
    foamRaw = d0.w * 0.45 + d1.w * 1.0 + d2.w * 0.6;
  }

  // rain ripples: normal perturbation near the camera, extra roughness further away
  vec3 rr = rainRipples(vXZ, uTime, uRain, dist);
  s += rr.xy;
  // unresolved capillary roughness: sparkles near the camera, smooth BRDF lobe far away
  float unres = uUnresolved * 0.5 * mix(0.12, 1.0, smoothstep(4.0, 500.0, dist));
  vec2 sigmaSq = var + vec2(unres) + vec2(rr.z);
  sigmaSq = max(sigmaSq, vec2(2e-5));

  vec3 N = normalize(vec3(-s.x, 1.0, -s.y));
  vec3 Ty = normalize(cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 Tx = cross(Ty, N);

  vec3 L = uSunDir;
  float nv = max(dot(N, V), 0.0);
  // view-direction slope variance for the averaged Fresnel
  vec2 vh = normalize(V.xz + 1e-6);
  float sigmaV = sqrt(dot(vh * vh, sigmaSq));
  float F = 0.02 + 0.98 * meanFresnel(nv, sigmaV);

  // sun visibility through clouds
  vec2 suv = (P.xz - uShadowRect.xy) * uShadowRect.zw;
  float sunVis = texture(uCloudShadow, suv).r;

  // reflection of the sky / clouds, blurred by the unresolved roughness
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  float rough = sqrt(sigmaSq.x + sigmaSq.y);
  float envLod = clamp(log2(rough * 96.0), 0.0, 7.0);
  vec3 sky = envSample(R, envLod);
  vec3 refl = F * sky;

  // sun glitter
  vec3 sun = uSunE * sunVis * reflectedSun(L, V, N, Tx, Ty, sigmaSq);

  // water-leaving radiance (deep, optically infinite water)
  vec3 Ed = uSunE * sunVis * max(L.y, 0.0) + uSkyE + uFlash * 0.3;
  vec3 body = uRrs * Ed * (1.0 - F) / 0.98;

  // crest subsurface scattering (light transmitted through thin backlit crests)
  float H = max(vDisp + 0.15 * uHs, 0.0) / max(uHs, 0.3);
  float back = pow(max(dot(L, -V), 0.0), 4.0) * pow(0.5 - 0.5 * dot(L, N), 3.0);
  float side = pow(nv, 2.0) * 0.18;
  vec3 sss = uSSS * (1.0 - F) * (H * back * 3.0 * uSunE * sunVis + side * (uSkyE + uSunE * sunVis * max(L.y, 0.0) * 0.3));

  vec3 col = refl + sun + body + sss;

  // foam
  vec2 fc = foamCoverage(vXZ, foamRaw * uFoamAmount, uTime, dist);
  float foam = fc.x;
  if (uDebug == 1) { oColor = vec4(foam, foamRaw, 0.0, 1.0); return; }
  if (foam > 0.0) {
    // bubble layer: thick fresh foam is a bright diffuse scatterer (albedo ~0.8);
    // thin residual foam is translucent and picks up the water's blue-green
    float thick = fc.y;
    vec3 Nf = normalize(vec3(-s.x * 0.5, 1.0, -s.y * 0.5));
    float wrapL = max((dot(Nf, L) + 0.35) / 1.35, 0.0);
    vec3 Ein = uSunE * sunVis * wrapL + uSkyE + uFlash;
    float albedo = mix(0.32, 0.86, thick);
    vec3 tint = mix(vec3(0.62, 0.86, 0.9), vec3(1.0), thick);
    vec3 foamCol = albedo * tint * Ein / M_PI;
    col = mix(col, foamCol, foam * mix(0.55, 1.0, thick));
  }

  // lightning reflection (broad, from cloud base)
  col += F * uFlash * 0.08;

  // aerial perspective
  vec3 dir = -V;
  vec3 aL, aT;
  aerial(dir, dist * 0.001, aL, aT);
  col = col * aT + aL;
  // rain / mist fog
  col = applyFog(col, -V, dist);
  oColor = vec4(col, 1.0);
}`;

export class Water {
  constructor(gl, { angular = 512, rings = 780, center = 0.03, far = 40000 } = {}) {
    this.gl = gl;
    this.prog = new Program(gl, VS, FS, { label: 'water' });
    const ang = (2 * Math.PI) / angular;
    const q = 1 + ang;
    const a = center / ang;
    const radii = [0];
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
