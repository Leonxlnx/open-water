// Minimal WebGL2 toolkit: programs with reflected uniforms, textures, framebuffers, fullscreen passes.

export function createGL(canvas, { antialias = false, preserve = false } = {}) {
  const gl = canvas.getContext('webgl2', {
    antialias,
    alpha: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: preserve,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is not available');
  const ext = {
    cbf: gl.getExtension('EXT_color_buffer_float'),
    fl: gl.getExtension('OES_texture_float_linear'),
    aniso: gl.getExtension('EXT_texture_filter_anisotropic'),
  };
  if (!ext.cbf) throw new Error('EXT_color_buffer_float is required');
  gl.ext = ext;
  gl.maxAniso = ext.aniso ? gl.getParameter(ext.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;
  return gl;
}

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
`;

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    const lines = src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} ${l}`);
    const m = /0:(\d+)/.exec(log);
    const at = m ? Number(m[1]) : 0;
    const ctx = lines.slice(Math.max(0, at - 6), at + 3).join('\n');
    throw new Error(`[${label}] shader compile error\n${log}\n${ctx}`);
  }
  return sh;
}

export const FULLSCREEN_VS = `
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export class Program {
  constructor(gl, vs, fs, { label = 'program', defines = {} } = {}) {
    this.gl = gl;
    const defs = Object.entries(defines).map(([k, v]) => `#define ${k} ${v}\n`).join('');
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, HEADER + defs + vs, label + '.vs'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, HEADER + defs + fs, label + '.fs'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(`[${label}] link error\n${gl.getProgramInfoLog(p)}`);
    }
    this.program = p;
    this.uniforms = {};
    this.samplers = {};
    let unit = 0;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(p, info.name);
      const u = { loc, type: info.type, size: info.size };
      if (isSampler(gl, info.type)) {
        u.unit = unit;
        unit += info.size;
        this.samplers[name] = u;
      }
      this.uniforms[name] = u;
    }
    gl.useProgram(p);
    for (const s of Object.values(this.samplers)) {
      if (s.size > 1) gl.uniform1iv(s.loc, Array.from({ length: s.size }, (_, j) => s.unit + j));
      else gl.uniform1i(s.loc, s.unit);
    }
  }

  use(values = {}) {
    const gl = this.gl;
    gl.useProgram(this.program);
    for (const k in values) this.set(k, values[k]);
    return this;
  }

  set(name, v) {
    const u = this.uniforms[name];
    if (!u || v === undefined) return;
    const gl = this.gl;
    switch (u.type) {
      case gl.FLOAT: (Array.isArray(v) || ArrayBuffer.isView(v)) ? gl.uniform1fv(u.loc, Array.from(v).slice(0, u.size)) : gl.uniform1f(u.loc, v); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(u.loc, v); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(u.loc, v); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(u.loc, v); break;
      case gl.INT: case gl.BOOL: u.size > 1 ? gl.uniform1iv(u.loc, v) : gl.uniform1i(u.loc, v); break;
      case gl.INT_VEC2: gl.uniform2iv(u.loc, v); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(u.loc, false, v); break;
      case gl.FLOAT_MAT4: gl.uniformMatrix4fv(u.loc, false, v); break;
      default:
        if (isSampler(gl, u.type)) {
          const list = (Array.isArray(v) ? v : [v]).slice(0, u.size);
          list.forEach((t, j) => {
            gl.activeTexture(gl.TEXTURE0 + u.unit + j);
            gl.bindTexture(samplerTarget(gl, u.type), t && t.tex ? t.tex : t);
          });
        }
    }
  }
}

function isSampler(gl, t) {
  return t === gl.SAMPLER_2D || t === gl.SAMPLER_3D || t === gl.SAMPLER_2D_ARRAY || t === gl.SAMPLER_CUBE ||
    t === gl.INT_SAMPLER_2D || t === gl.UNSIGNED_INT_SAMPLER_2D;
}
function samplerTarget(gl, t) {
  if (t === gl.SAMPLER_3D) return gl.TEXTURE_3D;
  if (t === gl.SAMPLER_2D_ARRAY) return gl.TEXTURE_2D_ARRAY;
  if (t === gl.SAMPLER_CUBE) return gl.TEXTURE_CUBE_MAP;
  return gl.TEXTURE_2D;
}

const FORMATS = {
  rgba32f: ['RGBA32F', 'RGBA', 'FLOAT'],
  rgba16f: ['RGBA16F', 'RGBA', 'HALF_FLOAT'],
  rg16f: ['RG16F', 'RG', 'HALF_FLOAT'],
  rg32f: ['RG32F', 'RG', 'FLOAT'],
  r16f: ['R16F', 'RED', 'HALF_FLOAT'],
  r32f: ['R32F', 'RED', 'FLOAT'],
  r8: ['R8', 'RED', 'UNSIGNED_BYTE'],
  rgba8: ['RGBA8', 'RGBA', 'UNSIGNED_BYTE'],
  r11g11b10f: ['R11F_G11F_B10F', 'RGB', 'HALF_FLOAT'],
};

export class Texture {
  constructor(gl, { w, h, d = 0, format = 'rgba16f', filter = 'linear', wrap = 'clamp', mips = false, aniso = 0, data = null }) {
    this.gl = gl;
    this.w = w; this.h = h; this.d = d;
    this.target = d ? gl.TEXTURE_3D : gl.TEXTURE_2D;
    this.mips = mips;
    const [ifmt, fmt, type] = FORMATS[format];
    this.ifmt = gl[ifmt]; this.fmt = gl[fmt]; this.type = gl[type];
    this.tex = gl.createTexture();
    gl.bindTexture(this.target, this.tex);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h, d || 1))) + 1 : 1;
    if (d) gl.texStorage3D(this.target, levels, this.ifmt, w, h, d);
    else gl.texStorage2D(this.target, levels, this.ifmt, w, h);
    if (data) this.upload(data);
    const lin = filter === 'linear';
    gl.texParameteri(this.target, gl.TEXTURE_MIN_FILTER, mips ? (lin ? gl.LINEAR_MIPMAP_LINEAR : gl.NEAREST_MIPMAP_NEAREST) : (lin ? gl.LINEAR : gl.NEAREST));
    gl.texParameteri(this.target, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST);
    const wr = wrap === 'repeat' ? gl.REPEAT : wrap === 'mirror' ? gl.MIRRORED_REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_S, wr);
    gl.texParameteri(this.target, gl.TEXTURE_WRAP_T, wr);
    if (d) gl.texParameteri(this.target, gl.TEXTURE_WRAP_R, wr);
    if (aniso && gl.ext.aniso) gl.texParameterf(this.target, gl.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, gl.maxAniso));
  }
  upload(data) {
    const gl = this.gl;
    gl.bindTexture(this.target, this.tex);
    const type = data instanceof Float32Array ? gl.FLOAT : this.type;
    if (this.d) gl.texSubImage3D(this.target, 0, 0, 0, 0, this.w, this.h, this.d, this.fmt, type, data);
    else gl.texSubImage2D(this.target, 0, 0, 0, this.w, this.h, this.fmt, type, data);
  }
  dispose() { this.gl.deleteTexture(this.tex); }
  genMips() {
    const gl = this.gl;
    gl.bindTexture(this.target, this.tex);
    gl.generateMipmap(this.target);
  }
}

export class Target {
  // Framebuffer over one or more color textures (MRT). Optional depth renderbuffer.
  constructor(gl, textures, { depth = false, layer = -1 } = {}) {
    this.gl = gl;
    this.textures = textures;
    this.w = textures[0].w; this.h = textures[0].h;
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    textures.forEach((t, i) => {
      if (t.d) gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, t.tex, 0, layer);
      else gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t.tex, 0);
    });
    if (depth) {
      this.depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depth);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, this.w, this.h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depth);
    }
    gl.drawBuffers(textures.map((_, i) => gl.COLOR_ATTACHMENT0 + i));
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('framebuffer incomplete: 0x' + st.toString(16));
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
  }
  dispose(withTextures = false) {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    if (this.depth) gl.deleteRenderbuffer(this.depth);
    if (withTextures) this.textures.forEach((t) => t.dispose());
  }
}

// Multisampled HDR color + depth that resolves into a texture. Drivers differ in which float
// formats they can multisample, so `formats` is a preference list: the first combination of
// format and sample count that gives a complete framebuffer wins (this.format reports it; the
// resolve target must use the same format).
export class MSTarget {
  constructor(gl, w, h, samples, formats = ['rgba16f']) {
    this.gl = gl;
    this.w = w; this.h = h;
    const list = Array.isArray(formats) ? formats : [formats];
    for (const format of list) {
      const [ifmt] = FORMATS[format];
      const supported = Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, gl[ifmt], gl.SAMPLES) || []);
      const counts = [...new Set([...supported.filter((s) => s <= samples).sort((a, b) => b - a), 0])];
      for (const n of counts) {
        if (this.tryCreate(gl[ifmt], n)) { this.format = format; this.samples = n; return; }
      }
    }
    throw new Error('no renderable HDR framebuffer format (' + list.join(', ') + ')');
  }
  tryCreate(ifmt, samples) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const color = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, ifmt, this.w, this.h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
    const depth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, this.w, this.h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(color); gl.deleteRenderbuffer(depth);
      return false;
    }
    this.fbo = fbo; this.color = color; this.depth = depth;
    return true;
  }
  bind() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.w, this.h);
  }
  dispose() {
    const gl = this.gl;
    gl.deleteFramebuffer(this.fbo);
    gl.deleteRenderbuffer(this.color);
    gl.deleteRenderbuffer(this.depth);
  }
  resolve(target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.fbo);
    gl.blitFramebuffer(0, 0, this.w, this.h, 0, 0, target.w, target.h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }
}

let emptyVao = null;
export function bindEmpty(gl) {
  if (!emptyVao) emptyVao = gl.createVertexArray();
  gl.bindVertexArray(emptyVao);
}
export function fullscreen(gl, program, uniforms, target) {
  if (!emptyVao) emptyVao = gl.createVertexArray();
  if (target) target.bind();
  else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
  program.use(uniforms);
  gl.bindVertexArray(emptyVao);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

export function makeMesh(gl, attribs, indices) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  let loc = 0;
  for (const [data, size] of attribs) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    loc++;
  }
  let count = 0;
  let itype = gl.UNSIGNED_INT;
  if (indices) {
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    count = indices.length;
    itype = indices instanceof Uint16Array ? gl.UNSIGNED_SHORT : gl.UNSIGNED_INT;
  }
  gl.bindVertexArray(null);
  return { vao, count, itype };
}
