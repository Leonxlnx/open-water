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
    vec2 ct = 0.6 / vec2(textureSize(uClouds, 0));
    vec4 cl = (texture(uClouds, vUv + vec2(-ct.x, -ct.y)) + texture(uClouds, vUv + vec2(ct.x, -ct.y))
             + texture(uClouds, vUv + vec2(-ct.x, ct.y)) + texture(uClouds, vUv + vec2(ct.x, ct.y))) * 0.25;
    vec3 sunPart = col - skyRadiance(d);
    col = skyRadiance(d) * cl.a + sunPart * cl.a * cl.a * cl.a + cl.rgb;
  }
  // rain/mist veil towards the horizon
  col = max(col + shafts(uCamPos, d, 1e9), vec3(0.0));
  col = applyFog(col, d, 1e9);
  o = vec4(col, 1.0);
}`;

const ENV_FS = SKY_LOOKUP_GLSL + `
in vec2 vUv;
out vec4 o;
uniform sampler2D uCloudsEnv;  // rgb in-scatter, a transmittance in env parameterisation
uniform float uCloudsOn;
uniform float uSunVis;
const float PI_ = 3.14159265359;
void main() {
  float phi = (vUv.x - 0.5) * 2.0 * PI_;
  float theta = vUv.y * PI_;
  vec3 d = vec3(cos(phi) * sin(theta), cos(theta), sin(phi) * sin(theta));
  d.y = max(d.y, 0.0);
  d = normalize(d + vec3(0.0, 0.002, 0.0));
  vec3 col = skyRadiance(d);
  // a soft sun (pre-blurred); the sharp glint is handled analytically by the BRDF
  if (uCloudsOn > 0.5) {
    // below the horizon the probe repeats the horizon row (not unclouded clear sky)
    vec4 cl = texture(uCloudsEnv, vec2(vUv.x, min(vUv.y, 0.5 - 0.6 / float(textureSize(uCloudsEnv, 0).y))));
    col = col * cl.a + cl.rgb;
  }
  col = applyFog(col, d, 1e9);
  o = vec4(col, 1.0);
}`;

const IRR_FS = `
out vec4 o;
uniform sampler2D uEnv;
const float PI_ = 3.14159265359;
vec2 equirectUv(vec3 d) { return vec2(atan(d.z, d.x) / (2.0 * PI_) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI_); }
void main() {
  // cosine-weighted hemisphere integral of the environment (sky + clouds)
  vec3 E = vec3(0.0);
  for (int i = 0; i < 16; i++) for (int j = 0; j < 6; j++) {
    float phi = (float(i) + 0.5) / 16.0 * 2.0 * PI_;
    float ct = (float(j) + 0.5) / 6.0; // uniform in cos(theta)
    float st = sqrt(1.0 - ct * ct);
    vec3 d = vec3(cos(phi) * st, ct, sin(phi) * st);
    E += textureLod(uEnv, equirectUv(d), 4.0).rgb * ct;
  }
  // E = integral L cos dOmega = 2 pi * mean(L cos) for samples uniform in cos(theta)
  o = vec4(E / float(16 * 6) * 2.0 * PI_, 1.0);
}`;

export class Sky {
  constructor(gl) {
    this.gl = gl;
    this.pSky = new Program(gl, FULLSCREEN_VS, SKY_FS, { label: 'sky' });
    this.pEnv = new Program(gl, FULLSCREEN_VS, ENV_FS, { label: 'env' });
    this.env = new Texture(gl, { w: 512, h: 256, format: 'rgba16f', mips: true, wrap: 'clamp' });
    this.envTarget = new Target(gl, [this.env]);
    // wrap in azimuth (seam at 180 deg), clamp in elevation
    gl.bindTexture(gl.TEXTURE_2D, this.env.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    this.pIrr = new Program(gl, FULLSCREEN_VS, IRR_FS, { label: 'irradiance' });
    this.irradiance = new Texture(gl, { w: 1, h: 1, format: 'rgba16f', filter: 'nearest' });
    this.irrTarget = new Target(gl, [this.irradiance]);
  }
  renderEnv(uniforms) {
    fullscreen(this.gl, this.pEnv, uniforms, this.envTarget);
    this.env.genMips();
    fullscreen(this.gl, this.pIrr, { uEnv: this.env }, this.irrTarget);
  }
  drawBackground(uniforms) {
    const gl = this.gl;
    this.pSky.use(uniforms);
    bindEmpty(gl);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
