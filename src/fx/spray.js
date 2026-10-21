// Spindrift: above ~Beaufort 7 the wind tears spray off breaking crests. Particles are seeded at
// random points around the camera and only live where the sea is actively breaking (dense fresh
// foam on the crest); they rise, are carried downwind at ~0.6 U, spread and settle back.
import { Program } from '../gl.js';
import { SKY_LOOKUP_GLSL } from '../sky/atmosphere.js';
import { rng } from '../math.js';

const VS = `
layout(location = 0) in vec4 aSeed;
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform vec2 uAnchor;        // spawn-field centre (camera base, does not sway)
uniform float uTime;
uniform float uRadius;
uniform float uStrength;     // 0..1 with wind (gale and above)
uniform vec2 uWind;          // m/s
uniform sampler2D uDisp[3];
uniform sampler2D uActive;      // active breaking (117 m cascade)
uniform float uSize[4];
centroid out vec2 vUv;
out float vAlpha;
out float vDist;
out float vAlong;
float h1(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  float life = 1.6 + aSeed.z * 1.6;
  float tt = uTime / life + aSeed.x * 31.0;
  float cyc = floor(tt);
  float age = fract(tt);                 // 0..1 over the particle life
  float r = sqrt(h1(cyc * 1.31 + aSeed.y * 77.0)) * uRadius;
  float a = h1(cyc * 2.71 + aSeed.x * 53.0) * 6.2831853;
  vec2 xz = uAnchor + vec2(cos(a), sin(a)) * r;
  // where is the sea breaking right now? dense foam on a crest
  vec4 d0 = textureLod(uDisp[0], xz / uSize[0], 1.0);
  vec4 d1 = textureLod(uDisp[1], xz / uSize[1], 1.0);
  float crest = d0.y + d1.y;
  // spray is torn off crests that are breaking right now
  float act = textureLod(uActive, xz / uSize[1], 1.0).r;
  float alive = smoothstep(0.15, 0.6, act) * step(0.0, crest) * uStrength;
  if (alive < 0.01 || aSeed.w > uStrength) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vAlpha = 0.0; return; }
  float T = age * life;
  vec3 start = vec3(xz.x + d0.x + d1.x, crest + 0.3, xz.y + d0.z + d1.z);
  vec3 vel = vec3(uWind.x, 0.0, uWind.y) * (0.45 + 0.25 * aSeed.y);
  // ballistic rise and settle, slowed by drag
  vec3 pos = start + vel * T + vec3(0.0, (0.6 + 1.0 * aSeed.z) * T - 1.0 * T * T, 0.0);
  float size = mix(0.3, 1.6 + 1.2 * aSeed.y, sqrt(age));
  vec3 toCam = uCamPos - pos;
  float dist = length(toCam);
  vec3 vdir = toCam / max(dist, 1e-3);
  vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) - 0.5;
  vec3 wdir = normalize(vec3(uWind.x, 0.0, uWind.y) + 1e-4);
  // a sheet drawn out along the wind: the wind direction projected into the view plane
  vec3 along = wdir - vdir * dot(wdir, vdir);
  float al = length(along);
  along = al > 0.2 ? along / al : right;
  vec3 up = normalize(cross(vdir, along));
  // further away a sheet is smeared over more of its drift: longer
  vec3 P = pos + along * c.x * size * mix(2.4, 8.0, smoothstep(20.0, 150.0, dist)) * mix(0.35, 1.0, smoothstep(0.2, 0.6, al)) + up * c.y * size * 0.7;
  vAlong = smoothstep(0.2, 0.6, al);
  vUv = c + 0.5;
  vAlpha = alive * sin(3.14159 * age) * (1.0 - smoothstep(uRadius * 0.6, uRadius, dist)) * smoothstep(8.0, 25.0, dist);
  vDist = dist;
  gl_Position = uViewProj * vec4(P, 1.0);
}`;

const FS = SKY_LOOKUP_GLSL + `
centroid in vec2 vUv;
in float vAlpha;
in float vDist;
in float vAlong;
out vec4 oColor;
uniform vec3 uFlash;
float hsh(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y); }
void main() {
  vec2 q = vUv * 2.0 - 1.0;
  float r = dot(q, q);
  // streaky along the sheet (u runs along the wind)
  // streaky along the wind; seen end-on (no length to streak) an isotropic puff
  vec2 sc = mix(vec2(6.0, 6.0), vec2(2.5, 11.0), vAlong);
  float n = vn(vUv * sc) * 0.6 + vn(vUv * sc * 2.2 + 3.1) * 0.4;
  float a = exp(-r * 2.2) * smoothstep(0.35, 0.85, n) * vAlpha * 0.45;
  // fine droplets scatter skylight and sun (forward-scattering, like mist)
  vec3 L = skyIrradiance() * (0.9 / 3.14159) + sunIlluminance() * uHazeSun * max(uSunDir.y, 0.0) * 0.35 + uFlash * 0.3;
  oColor = vec4(L * a, a);
}`;

export class Spray {
  constructor(gl, count = 12000) {
    this.gl = gl;
    this.count = count;
    this.prog = new Program(gl, VS, FS, { label: 'spray' });
    const r = rng(41);
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) { data[i * 4] = r(); data[i * 4 + 1] = r(); data[i * 4 + 2] = r(); data[i * 4 + 3] = (i + r()) / count; }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindVertexArray(null);
  }

  draw(u) {
    const strength = Math.min(Math.max((u.wind - 13) / 9, 0), 1);
    if (strength <= 0) return;
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    this.prog.use({
      ...u.skyU, uViewProj: u.viewProj, uCamPos: u.camPos, uAnchor: u.anchor || [0, 0], uTime: u.time, uRadius: 250,
      uStrength: strength, uWind: u.windVec, uDisp: u.disp, uActive: u.active, uSize: u.sizes, uFlash: u.flash,
    });
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
