// Samples the ocean surface under the camera (height, mean slope over a boat-sized footprint,
// horizontal orbital displacement) and reads it back without stalling (PBO + fence).
import { Program, Texture, Target, fullscreen, FULLSCREEN_VS } from '../gl.js';

const PROBE_FS = `
uniform sampler2D uDisp[3];
uniform sampler2D uSlope[3];
uniform float uSize[4];
uniform float uTexel[4];
uniform vec2 uXZ;
uniform float uFootprint;   // metres: waves shorter than this barely move the boat
out vec4 o;
vec3 disp(vec2 xz) {
  float l = log2(uFootprint);
  vec3 D = textureLod(uDisp[0], xz / uSize[0], max(l - log2(uTexel[0]), 0.0)).xyz;
  D += textureLod(uDisp[1], xz / uSize[1], max(l - log2(uTexel[1]), 0.0)).xyz;
  D += textureLod(uDisp[2], xz / uSize[2], max(l - log2(uTexel[2]), 0.0)).xyz;
  return D;
}
void main() {
  int i = int(gl_FragCoord.x);
  // invert the horizontal (choppy) displacement: find x0 with x0 + D(x0) = x
  vec2 x0 = uXZ;
  for (int k = 0; k < 4; k++) x0 = uXZ - disp(x0).xz;
  vec3 D = disp(x0);
  if (i == 0) { o = vec4(D, 1.0); return; }
  float l = log2(uFootprint * 1.5);
  vec2 s = textureLod(uSlope[0], x0 / uSize[0], max(l - log2(uTexel[0]), 0.0)).xy;
  s += textureLod(uSlope[1], x0 / uSize[1], max(l - log2(uTexel[1]), 0.0)).xy;
  s += textureLod(uSlope[2], x0 / uSize[2], max(l - log2(uTexel[2]), 0.0)).xy;
  o = vec4(s, 0.0, 1.0);
}`;

export class OceanProbe {
  constructor(gl) {
    this.gl = gl;
    this.prog = new Program(gl, FULLSCREEN_VS, PROBE_FS, { label: 'probe' });
    this.tex = new Texture(gl, { w: 2, h: 1, format: 'rgba32f', filter: 'nearest' });
    this.target = new Target(gl, [this.tex]);
    this.pbo = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 32, gl.STREAM_READ);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.data = new Float32Array(8);
    this.result = { height: 0, dx: 0, dz: 0, sx: 0, sz: 0 };
    this.fence = null;
  }

  // sync: blocking readback (deterministic offline rendering); otherwise 1-3 frames latency.
  run(ot, xz, footprint, sync = false) {
    const gl = this.gl;
    if (this.fence && !sync) {
      if (gl.clientWaitSync(this.fence, 0, 0) !== gl.TIMEOUT_EXPIRED) {
        gl.deleteSync(this.fence);
        this.fence = null;
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.data);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        this.decode();
      }
    }
    if (this.fence && !sync) return this.result;
    fullscreen(gl, this.prog, {
      uDisp: ot.disp.slice(0, 3), uSlope: ot.slope.slice(0, 3), uSize: ot.sizes, uTexel: ot.texels, uXZ: xz, uFootprint: footprint,
    }, this.target);
    if (sync) {
      gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, this.data);
      this.decode();
      return this.result;
    }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo);
    gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    return this.result;
  }

  decode() {
    const d = this.data;
    this.result = { dx: d[0], height: d[1], dz: d[2], sx: d[4], sz: d[5] };
  }
}
