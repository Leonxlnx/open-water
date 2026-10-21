// Rain: motion-blurred drop streaks around the camera and splash jets on the sea surface.
// Drop diameters follow Marshall-Palmer N(D) = N0 exp(-Lambda D), Lambda = 4.1 R^-0.21 /mm;
// terminal velocity v(D) = 9.65 - 10.3 exp(-0.6 D) m/s (Atlas et al. 1973).
// A drop covers a point of its streak only for D / (v T) of the exposure T, which is why
// rain streaks are faint and only read against darker backgrounds (Garg & Nayar 2006).
import { Program } from '../gl.js';
import { SKY_LOOKUP_GLSL } from '../sky/atmosphere.js';
import { rng } from '../math.js';

const STREAK_VS = `
layout(location = 0) in vec4 aSeed;   // xyz: position in box (0..1), w: size quantile
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec3 uBox;                    // box size (m)
uniform float uTime;
uniform vec2 uWind;                   // horizontal wind (m/s), for the streak direction
uniform vec2 uDrift;                  // integrated horizontal drift (m): positions stay coherent as the wind changes
uniform float uExposure;              // shutter time (s)
uniform float uLambda;                // Marshall-Palmer slope (1/mm)
uniform float uCount;                 // active fraction
uniform vec2 uViewport;
uniform float uPixelAngle;            // radians per pixel
centroid out vec2 vUv;
out float vAlpha;
out vec3 vDir;
out float vDist;
void main() {
  float idx = float(gl_InstanceID);
  if (aSeed.w > uCount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  // drop diameter (mm) from an exponential distribution, truncated to visible sizes
  float u = fract(aSeed.w * 7.31 + aSeed.x * 3.17);
  float D = clamp(-log(1.0 - u * 0.985) / uLambda + 0.35, 0.35, 5.0);
  float v = 9.65 - 10.3 * exp(-0.6 * D);
  vec3 vel = vec3(uWind.x, -v, uWind.y);
  // fall speed for the position comes from a fixed per-drop size (independent of the rain rate)
  float Dk = 0.35 - log(1.0 - u * 0.985) / 2.0;
  float vk = 9.65 - 10.3 * exp(-0.6 * Dk);
  // world-anchored positions wrapped into a camera-centred box (no swimming when moving)
  vec3 p = aSeed.xyz * uBox + vec3(uDrift.x, -vk * uTime, uDrift.y);
  vec3 rel = mod(p - uCamPos + uBox * 0.5, uBox) - uBox * 0.5;
  rel.y += uBox.y * 0.5 - 2.0;
  vec3 head = uCamPos + rel;
  vec3 tail = head - vel * uExposure;
  vec3 mid = (head + tail) * 0.5;
  vec3 toCam = uCamPos - mid;
  float dist = length(toCam);
  vec3 axis = head - tail;
  vec3 side = normalize(cross(axis, toCam));
  // physical width, clamped to one pixel (energy kept by scaling alpha)
  float wPhys = D * 0.001;
  float wPix = dist * uPixelAngle;
  float w = max(wPhys, wPix * 1.2);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec3 pos = mix(tail, head, corner.y) + side * (corner.x - 0.5) * w;
  vUv = corner;
  // duty cycle of the streak (D / (v T)) times sub-pixel coverage
  vAlpha = (wPhys / w) * min(D * 0.001 / (v * uExposure), 1.0);
  vAlpha *= smoothstep(0.25, 0.9, dist) * (1.0 - smoothstep(uBox.x * 0.32, uBox.x * 0.5, dist));
  vDir = normalize(mid - uCamPos);
  vDist = dist;
  gl_Position = uViewProj * vec4(pos, 1.0);
  if (head.y < -0.5) vAlpha = 0.0; // below the mean sea level: hidden by the water anyway
}`;

const STREAK_FS = SKY_LOOKUP_GLSL + `
centroid in vec2 vUv;
in float vAlpha;
in vec3 vDir;
in float vDist;
out vec4 oColor;
uniform sampler2D uEnv;
uniform vec3 uFlash;
uniform float uGain;
vec2 equirectUv(vec3 d) { return vec2(atan(d.z, d.x) / 6.2831853 + 0.5, acos(clamp(d.y, -1.0, 1.0)) / 3.14159265); }
void main() {
  float across = clamp(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0, 1.0);
  float along = smoothstep(0.0, 0.15, vUv.y) * smoothstep(1.0, 0.8, vUv.y);
  // a drop is a wide-angle lens: it shows a blurred, inverted image of the bright sky
  vec3 sky = textureLod(uEnv, equirectUv(vec3(0.0, 1.0, 0.0)), 6.0).rgb * 0.6
           + textureLod(uEnv, equirectUv(normalize(vec3(vDir.x, 0.35, vDir.z))), 5.0).rgb * 0.4;
  vec3 L = sky * 1.15 + uFlash * 0.25;
  float a = vAlpha * across * along * uGain;
  a = clamp(a, 0.0, 1.0);
  oColor = vec4(L * a, a);
}`;

// Splashes: the crown of an impact, a few mm tall and ~50 ms long; only the largest drops throw a
// Worthington jet of 2-4 cm.
const SPLASH_VS = `
layout(location = 0) in vec4 aSeed;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uTime;
uniform float uRadius;
uniform float uCount;
uniform sampler2D uDisp[3];
uniform float uSize[4];
uniform float uPixelAngle;
centroid out vec2 vUv;
out float vAlpha;
out float vJet;
float h1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  if (aSeed.w > uCount) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float period = 0.35 + aSeed.z * 0.5;
  float tt = uTime / period + aSeed.x * 17.0;
  float cyc = floor(tt);
  float ph = fract(tt);
  float life = 0.05 / period;   // ~50 ms of the cycle
  // new random spot each cycle, uniformly over a disc around the camera
  // world-anchored spots, wrapped into a square around the camera
  vec2 o = (vec2(h1(cyc * 1.7 + aSeed.y * 91.0), h1(cyc * 3.1 + aSeed.x * 57.0)) * 2.0 - 1.0) * uRadius;
  vec2 xz = uCamPos.xz + mod(o - uCamPos.xz + uRadius, 2.0 * uRadius) - uRadius;
  vec3 D = textureLod(uDisp[0], xz / uSize[0], 2.0).xyz + textureLod(uDisp[1], xz / uSize[1], 2.0).xyz + textureLod(uDisp[2], xz / uSize[2], 1.0).xyz;
  vec3 base = vec3(xz.x + D.x, D.y, xz.y + D.z);
  float t = ph / life;
  float q = aSeed.z;
  bool big = q > 0.95;
  float height = big ? mix(0.02, 0.04, (q - 0.95) * 20.0) : mix(0.003, 0.01, q / 0.95);
  float jet = sin(min(t, 1.0) * 3.14159) * height;
  vJet = big ? 1.0 : 0.0;
  vec3 toCam = uCamPos - base;
  float dist = length(toCam);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  // crown ~6-12 mm across; a jet is a thin column
  float wPhys = big ? 0.004 : 0.006 + 0.006 * q;
  float w = max(wPhys, dist * uPixelAngle * 1.2);
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec3 pos = base + side * (corner.x - 0.5) * w + vec3(0.0, corner.y * max(jet, 0.0015), 0.0);
  vUv = corner;
  // further out the specks are sub-pixel: they fade into the surface roughness (no hard band)
  vAlpha = (t < 1.0 ? 1.0 : 0.0) * (1.0 - smoothstep(uRadius * 0.3, uRadius, dist)) * min(wPhys / w, 1.0);
  gl_Position = uViewProj * vec4(pos, 1.0);
}`;

const SPLASH_FS = SKY_LOOKUP_GLSL + `
centroid in vec2 vUv;
in float vAlpha;
in float vJet;
out vec4 oColor;
uniform vec3 uFlash;
uniform float uGain;
void main() {
  float x = vUv.x * 2.0 - 1.0, y = clamp(vUv.y, 0.0, 1.0);
  // crown: two thin walls with beads at the rim; jet: a column with a drop on top
  float walls = exp(-pow((abs(x) - 0.6) / 0.22, 2.0)) * smoothstep(0.0, 0.35, y) * (1.0 - smoothstep(0.55, 0.9, y));
  float beads = exp(-pow((y - 0.85) / 0.12, 2.0)) * (exp(-pow((abs(x) - 0.65) / 0.16, 2.0)) + 0.7 * exp(-x * x / 0.03));
  float column = exp(-x * x / 0.12) * (smoothstep(0.0, 0.2, y) * (1.0 - smoothstep(0.7, 0.85, y)) + exp(-pow((y - 0.92) / 0.07, 2.0)));
  float shape = mix(max(walls, beads), column, vJet);
  // a thin water sheet: translucent, showing the sky above it
  vec3 L = skyIrradiance() * (0.7 / 3.14159) + sunIlluminance() * uHazeSun * max(uSunDir.y, 0.0) * 0.15 + uFlash * 0.2;
  float a = clamp(vAlpha * shape * uGain, 0.0, 0.65);
  oColor = vec4(L * a, a);
}`;

export class Rain {
  constructor(gl, { drops = 120000, splashes = 40000 } = {}) {
    this.gl = gl;
    this.drops = drops;
    this.splashes = splashes;
    this.pStreak = new Program(gl, STREAK_VS, STREAK_FS, { label: 'rain.streak' });
    this.pSplash = new Program(gl, SPLASH_VS, SPLASH_FS, { label: 'rain.splash' });
    this.vaoDrops = this.makeSeeds(drops, 11);
    this.vaoSplash = this.makeSeeds(splashes, 23);
  }

  makeSeeds(n, seed) {
    const gl = this.gl;
    const r = rng(seed);
    const data = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      data[i * 4] = r(); data[i * 4 + 1] = r(); data[i * 4 + 2] = r();
      data[i * 4 + 3] = (i + r()) / n; // ordered quantile: activating a prefix scales density smoothly
    }
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
    return vao;
  }

  draw(u) {
    const gl = this.gl;
    if (u.rain < 0.005) return;
    const rateMmH = u.rain * 50; // 0..50 mm/h (very heavy shower at the top)
    const lambda = 4.1 * Math.pow(Math.max(rateMmH, 0.5), -0.21);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    // splashes first (on the surface), then streaks
    this.pSplash.use({
      ...u.skyU, uViewProj: u.viewProj, uCamPos: u.camPos, uTime: u.time, uRadius: 16,
      uCount: Math.min(u.rain * 1.3, 1), uDisp: u.disp, uSize: u.sizes, uPixelAngle: u.pixelAngle,
      uFlash: u.flash, uGain: 2.4,
    });
    gl.bindVertexArray(this.vaoSplash);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.splashes);
    this.pStreak.use({
      ...u.skyU, uViewProj: u.viewProj, uCamPos: u.camPos, uBox: [36, 22, 36], uTime: u.time,
      uWind: u.wind, uDrift: u.drift || [0, 0], uExposure: u.exposure, uLambda: lambda, uCount: Math.min(Math.sqrt(u.rain) * 1.05, 1),
      uViewport: u.viewport, uPixelAngle: u.pixelAngle, uEnv: u.env, uFlash: u.flash, uGain: u.gain ?? 13,
    });
    gl.bindVertexArray(this.vaoDrops);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.drops);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
