// Lightning: Poisson-timed strikes with multiple return strokes, a procedural branching channel
// (fractal midpoint displacement), in-cloud illumination and thunder scheduling (343 m/s).
import { Program } from '../gl.js';
import { rng } from '../math.js';

const BOLT_VS = `
layout(location = 0) in vec4 aA;   // segment start xyz, intensity
layout(location = 1) in vec4 aB;   // segment end xyz, width scale
uniform mat4 uViewProj;
uniform vec3 uCamPos;
uniform float uPixelAngle;
uniform float uFogDensity;
out vec2 vUv;
out float vI;
void main() {
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec3 p = mix(aA.xyz, aB.xyz, c.y);
  vec3 toCam = uCamPos - p;
  float dist = length(toCam);
  vec3 side = normalize(cross(aB.xyz - aA.xyz, toCam));
  // a few metres of glowing channel, at least ~2.5 px wide; radiance scaled to keep energy
  float wPhys = 0.8 * aB.w;
  float wPix = dist * uPixelAngle * 1.6;
  float w = max(wPhys, wPix);
  vUv = c;
  vI = aA.w * (wPhys / w) * exp(-uFogDensity * dist * 0.6);
  gl_Position = uViewProj * vec4(p + side * (c.x - 0.5) * w, 1.0);
}`;

const BOLT_FS = `
in vec2 vUv;
in float vI;
out vec4 oColor;
uniform float uIntensity;
uniform vec3 uColor;
void main() {
  float x = abs(vUv.x * 2.0 - 1.0);
  float core = exp(-x * x * 9.0);
  oColor = vec4(uColor * core * vI * uIntensity, 0.0);
}`;

export class Lightning {
  constructor(gl, seed = 7) {
    this.gl = gl;
    this.rand = rng(seed);
    this.prog = new Program(gl, BOLT_VS, BOLT_FS, { label: 'lightning' });
    this.vao = gl.createVertexArray();
    this.buf = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.segments = 0;
    this.strike = null;
    this.nextIn = 4;
    this.events = []; // thunder events for the audio engine
    this.flash = 0;
    this.bolt = 0;
    this.pos = [0, 0, 0];
  }

  // Force a strike (UI / timeline)
  trigger(cam, opts = {}) {
    const r = this.rand;
    const dist = opts.dist ?? 1500 + Math.pow(r(), 1.5) * 12000;
    const az = opts.az ?? cam.yaw + (r() - 0.5) * 2.2;
    const x = cam.pos[0] + Math.cos(az) * dist, z = cam.pos[2] + Math.sin(az) * dist;
    const cloudBase = opts.base ?? 650;
    const ground = opts.ground ?? r() < 0.45;
    const strokes = 1 + Math.floor(r() * 3.5);
    const times = [0];
    for (let i = 1; i < strokes; i++) times.push(times[i - 1] + 0.04 + r() * 0.07);
    this.strike = {
      t: 0, times, ground, dist,
      pos: [x, cloudBase + 300 + r() * 1500, z],
      peak: 0.6 + r() * 0.8,
      duration: times[times.length - 1] + 0.35,
    };
    if (ground) this.buildBolt([x, cloudBase + 100, z], r);
    else this.segments = 0;
    this.events.push({ delay: dist / 343, dist, ground, power: this.strike.peak });
  }

  buildBolt(top, r) {
    const segs = [];
    const H = top[1];
    const walk = (a, b, depth, intensity, width) => {
      // midpoint displacement
      let pts = [a, b];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      let rough = len * 0.18;
      for (let lvl = 0; lvl < 7; lvl++) {
        const next = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
          const p = pts[i], q = pts[i + 1];
          next.push([(p[0] + q[0]) / 2 + (r() - 0.5) * rough, (p[1] + q[1]) / 2 + (r() - 0.5) * rough * 0.4, (p[2] + q[2]) / 2 + (r() - 0.5) * rough]);
          next.push(q);
        }
        pts = next;
        rough *= 0.55;
      }
      for (let i = 0; i < pts.length - 1; i++) {
        segs.push([...pts[i], intensity, ...pts[i + 1], width]);
        if (depth < 2 && r() < 0.035 * (1 - i / pts.length) && pts[i][1] > H * 0.15) {
          const p = pts[i];
          const blen = (p[1]) * (0.25 + r() * 0.45);
          const ang = r() * Math.PI * 2;
          const end = [p[0] + Math.cos(ang) * blen * 0.6, p[1] - blen, p[2] + Math.sin(ang) * blen * 0.6];
          walk(p, end, depth + 1, intensity * 0.35, width * 0.5);
        }
      }
    };
    const bottom = [top[0] + (r() - 0.5) * 400, -2, top[2] + (r() - 0.5) * 400];
    walk(top, bottom, 0, 1, 1);
    const data = new Float32Array(segs.length * 8);
    segs.forEach((s, i) => data.set(s, i * 8));
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.segments = segs.length;
  }

  update(dt, rate, cam, cloudBase) {
    this.flash = 0;
    this.bolt = 0;
    if (rate > 0.01) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) {
        this.trigger(cam, { base: cloudBase });
        // Poisson process: mean interval 25 s at rate 0.1 down to ~5 s at rate 1
        const mean = 3.5 / Math.pow(rate, 0.9);
        this.nextIn = -Math.log(1 - this.rand() * 0.98) * mean + 0.8;
      }
    }
    const s = this.strike;
    if (s) {
      s.t += dt;
      let i = 0;
      for (const t0 of s.times) {
        // average of the stroke's decay over this frame's exposure [s.t - dt, s.t]
        const a = Math.max(s.t - dt - t0, 0), b = s.t - t0;
        if (b > 0) i += (0.028 * (Math.exp(-a / 0.028) - Math.exp(-b / 0.028)) + 0.25 * 0.15 * (Math.exp(-a / 0.15) - Math.exp(-b / 0.15))) / Math.max(dt, 1e-4);
      }
      // stepped-leader flicker before the first stroke
      this.flash = Math.min(i, 2.5) * s.peak;
      this.bolt = s.ground ? Math.min(i, 2) * s.peak : 0;
      this.pos = s.pos;
      if (s.t > s.duration) this.strike = null;
    }
    return this.flash;
  }

  draw(u) {
    if (!this.segments || this.bolt < 0.01) return;
    const gl = this.gl;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    this.prog.use({ uViewProj: u.viewProj, uCamPos: u.camPos, uPixelAngle: u.pixelAngle, uFogDensity: u.fogDensity || 0, uIntensity: this.bolt * 2600, uColor: [0.82, 0.86, 1.0] });
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.segments);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }
}
