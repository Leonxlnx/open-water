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
const float SUN_COS = 0.99998917; // cos(0.2666 deg)
void main() {
  vec4 ndc = vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  vec3 d = normalize(w.xyz / w.w - uCamPos);
  vec3 col = skyRadiance(d);
  float c = dot(d, uSunDir);
  if (c > SUN_COS - 2e-5) {
    // sun disk with limb darkening (Neckel & Labs approximation)
    float mu = sqrt(max(0.0, 1.0 - (1.0 - c) / (1.0 - SUN_COS)));
    vec3 limb = pow(vec3(mu), vec3(0.397, 0.503, 0.652));
    float edge = smoothstep(SUN_COS - 2e-5, SUN_COS + 2e-5, c);
    col += sunIlluminance() * uSunVis / 6.8e-5 * limb * edge * 1.0;
  }
  if (uCloudsOn > 0.5) {
    vec4 cl = texture(uClouds, vUv);
    vec3 sunPart = col - skyRadiance(d);
    col = skyRadiance(d) * cl.a + sunPart * cl.a * cl.a * cl.a + cl.rgb;
  }
  // rain/mist veil towards the horizon
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
    vec4 cl = texture(uCloudsEnv, vUv);
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
