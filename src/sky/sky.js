// Sky background (atmosphere LUT + sun disk + clouds composite) and the reflection
// environment map (equirectangular, mip chain used as a roughness pre-filter).
import { Program, Texture, Target, fullscreen, bindEmpty, FULLSCREEN_VS } from '../gl.js';
import { SKY_LOOKUP_GLSL } from './atmosphere.js';

const SKY_FS = SKY_LOOKUP_GLSL + `
in vec2 vUv;
out vec4 o;
uniform mat4 uInvViewProj;
uniform vec3 uCamPos;
uniform sampler2D uClouds;   // rgb: in-scattered radiance, a: transmittance
uniform sampler2D uCloudDepth; // mean distance of the cloud light (km)
uniform float uCloudsOn;
uniform float uSunVis;
uniform float uIsMoon;
uniform float uPixelAngle;
uniform float uTime;
const float SUN_COS = 0.99998917; // cos(0.2666 deg)
float mhash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mhash(i), mhash(i + vec2(1, 0)), f.x), mix(mhash(i + vec2(0, 1)), mhash(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  vec3 d = normalize(w.xyz / w.w - uCamPos);
  vec3 col = skyRadiance(d);
  col += starField(d, uPixelAngle, uTime);
  float c = dot(d, uSunDir);
  float wEdge = 0.00465 * uPixelAngle;
  if (c > SUN_COS - wEdge) {
    // sun disk with limb darkening (Neckel & Labs approximation)
    float mu = sqrt(max(0.0, 1.0 - (1.0 - c) / (1.0 - SUN_COS)));
    // limb darkening I(mu) = mu^a, normalised so the disk carries the full illuminance
    vec3 limb = pow(vec3(mu), vec3(0.397, 0.503, 0.652)) * (1.0 + 0.5 * vec3(0.397, 0.503, 0.652));
    if (uIsMoon > 0.5) {
      // the moon: no limb darkening, darker maria (albedo ~0.07 vs ~0.12 highlands)
      vec3 t1 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
      vec2 q = vec2(dot(d - uSunDir, t1), dot(d - uSunDir, cross(t1, uSunDir))) / 0.00465;
      float maria = mnoise(q * 2.2 + 3.1) * 0.6 + mnoise(q * 5.0) * 0.3 + mnoise(q * 11.0) * 0.1;
      limb = vec3(mix(1.15, 0.62, smoothstep(0.45, 0.62, maria)));
    }
    float edge = smoothstep(SUN_COS - wEdge, SUN_COS + wEdge, c);
    col += sunIlluminance() * uSunVis / 6.8e-5 * limb * edge * 1.0;
  }
  if (uCloudsOn > 0.5) {
    // tent-filtered upsample of the low-resolution cloud buffer: removes residual ray-jitter speckle
    // (edge-aware: taps across a cloud edge, i.e. a different transmittance, get little weight)
    vec2 cts = vec2(textureSize(uClouds, 0));
    vec2 ct = (cts.x < float(textureSize(uSkyView, 0).x) * 4.0 && cts.x * 1.5 < 1.0 / max(fwidth(vUv.x), 1e-6) ? 0.6 : 0.0) / cts;
    vec4 c0 = texture(uClouds, vUv);
    vec4 t0 = texture(uClouds, vUv + vec2(-ct.x, -ct.y)), t1 = texture(uClouds, vUv + vec2(ct.x, -ct.y));
    vec4 t2 = texture(uClouds, vUv + vec2(-ct.x, ct.y)), t3 = texture(uClouds, vUv + vec2(ct.x, ct.y));
    float w0 = exp(-abs(t0.a - c0.a) * 8.0), w1 = exp(-abs(t1.a - c0.a) * 8.0), w2 = exp(-abs(t2.a - c0.a) * 8.0), w3 = exp(-abs(t3.a - c0.a) * 8.0);
    vec4 cl = (t0 * w0 + t1 * w1 + t2 * w2 + t3 * w3) / (w0 + w1 + w2 + w3);
    vec3 sunPart = col - skyRadiance(d);
    vec3 skyCol = skyRadiance(d) + sunPart * cl.a * cl.a;
    // rain and mist lie in front of the clouds only up to the clouds' distance (single scattering:
    // fog(x, s) = x T(s) + Lf (1 - T(s)), so cloud light and sky light are fogged separately)
    float cmd = max(texture(uCloudDepth, vUv).r * 1000.0, 1.0);
    vec3 Lm = applyFog(vec3(0.0), d, cmd);
    col = cl.a * applyFog(skyCol, d, 1e9) + applyFog(cl.rgb, d, cmd) - cl.a * Lm;
  } else {
    col = applyFog(col, d, 1e9);
  }
  col = withShafts(col, uCamPos, d, 1e9);
  o = vec4(col, 1.0);
}`;

const ENV_FS = SKY_LOOKUP_GLSL + `
in vec2 vUv;
layout(location = 0) out vec4 o;
layout(location = 1) out vec4 oDeck;   // the same without rain and mist: the light entering them
uniform sampler2D uCloudsEnv;  // rgb in-scatter, a transmittance in env parameterisation
uniform float uCloudsOn;
uniform float uSunVis;
uniform vec3 uEnvRrs;          // the sea's water-leaving reflectance (1/sr)
const float PI_ = 3.14159265359;
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * PI_;
  // below the horizon: the mirrored direction (see the end)
  float dy0 = cos(vUv.y * PI_);
  float vUp = min(vUv.y, 1.0 - vUv.y);
  float theta = vUp * PI_;
  vec3 d = vec3(cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  d = normalize(d + vec3(0.0, 0.002, 0.0));
  vec3 col = skyRadiance(d);
  // a soft sun (pre-blurred); the sharp glint is handled analytically by the BRDF
  if (uCloudsOn > 0.5) {
    vec4 cl = texture(uCloudsEnv, vec2(vUv.x, min(vUp, 0.5 - 0.6 / float(textureSize(uCloudsEnv, 0).y))));
    col = col * cl.a + cl.rgb;
  }
  vec3 deck = col;
  col = applyFog(col, d, 1e9);
  // A ray reflected below the horizon meets the next wave nearby and sees that wave: the sky mirrored
  // by its Fresnel reflectance and its water. The water shader folds such rays upwards itself; this
  // half only feeds the mip chain, whose wide blur on a rough sea must not average in the haze glare
  // that hugs the horizon.
  if (dy0 < 0.0) {
    float Fs = 0.02 + 0.98 * pow(1.0 - min(-dy0 + 0.12, 1.0), 5.0);
    vec3 Ed = sunIlluminance() * uSunVis * max(uSunDir.y, 0.0) + skyIrradiance();
    vec3 sea = Fs * col + (1.0 - Fs) * uEnvRrs * Ed;
    col = sea;
    deck = sea;
  }
  oDeck = vec4(deck, 1.0);
  o = vec4(col, 1.0);
}`;

const IRR_FS = `
out vec4 o;
uniform sampler2D uEnv;
uniform sampler2D uEnvDeck;
const float PI_ = 3.14159265359;
vec2 equirectUv(vec3 d) { return vec2(atan(d.z, d.x) / (2.0 * PI_) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI_); }
void main() {
  // cosine-weighted hemisphere integral of the environment (sky + clouds); texel 1: without rain/mist
  bool deck = gl_FragCoord.x > 1.0;
  vec3 E = vec3(0.0);
  for (int i = 0; i < 16; i++) for (int j = 0; j < 6; j++) {
    float phi = (float(i) + 0.5) / 16.0 * 2.0 * PI_;
    float ct = (float(j) + 0.5) / 6.0; // uniform in cos(theta)
    float st = sqrt(1.0 - ct * ct);
    vec3 d = vec3(cos(phi) * st, ct, sin(phi) * st);
    E += (deck ? textureLod(uEnvDeck, equirectUv(d), 4.0).rgb : textureLod(uEnv, equirectUv(d), 4.0).rgb) * ct;
  }
  // E = integral L cos dOmega = 2 pi * mean(L cos) for samples uniform in cos(theta)
  o = vec4(E / float(16 * 6) * 2.0 * PI_, 1.0);
}`;

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.pSky = new Program(gl, FULLSCREEN_VS, SKY_FS, { label: 'sky' });
    this.pEnv = new Program(gl, FULLSCREEN_VS, ENV_FS, { label: 'env' });
    this.env = new Texture(gl, { w: 512, h: 256, format: 'rgba16f', mips: true, wrap: 'clamp', aniso: 16 });
    this.envDeck = new Texture(gl, { w: 512, h: 256, format: 'rgba16f', mips: true, wrap: 'clamp' });
    this.envTarget = new Target(gl, [this.env, this.envDeck]);
    // wrap in azimuth (seam at 180 deg), clamp in elevation
    gl.bindTexture(gl.TEXTURE_2D, this.env.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    this.pIrr = new Program(gl, FULLSCREEN_VS, IRR_FS, { label: 'irradiance' });
    this.irradiance = new Texture(gl, { w: 2, h: 1, format: 'rgba16f', filter: 'nearest' });
    this.irrTarget = new Target(gl, [this.irradiance]);
  }
  renderEnv(uniforms) {
    fullscreen(this.gl, this.pEnv, uniforms, this.envTarget);
    this.env.genMips();
    this.envDeck.genMips();
    fullscreen(this.gl, this.pIrr, { uEnv: this.env, uEnvDeck: this.envDeck }, this.irrTarget);
  }
  drawBackground(uniforms) {
    const gl = this.gl;
    this.pSky.use(uniforms);
    bindEmpty(gl);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
