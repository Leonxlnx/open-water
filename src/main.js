import { createGL, Texture, Target, MSTarget, bindEmpty } from './gl.js';
import { perspective, viewFromBasis, mul, invert, v3, clamp, smoothstep } from './math.js';
import { Ocean } from './ocean/ocean.js';
import { Water } from './ocean/water.js';
import { FoamTexture } from './ocean/foam.js';
import { OceanProbe } from './ocean/probe.js';
import { Atmosphere } from './sky/atmosphere.js';
import { Sky } from './sky/sky.js';
import { Clouds } from './sky/clouds.js';
import { Post } from './fx/post.js';
import { Rain } from './fx/rain.js';
import { Lightning } from './fx/lightning.js';
import { Spray } from './fx/spray.js';
import { Weather } from './weather.js';
import { Profiler } from './profiler.js';
import { UI, UI_CSS } from './ui.js';
import { AudioEngine, renderSoundtrack, encodeWav } from './audio/audio.js';
import { film } from './film.js';

const params = new URLSearchParams(location.search);
const mixv = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const RENDER_MODE = params.has('render');
// quality tiers: 'rt' keeps the live app interactive on integrated GPUs, 'high' is for the film
const QUALITY = {
  rt: { cloudDiv: 3, steps: 44, lightSteps: 4, lightDetail: 1, blend: 0.14, msaa: 4, hdr: 'r11g11b10f', check: true, fft: [256, 256, 128, 128], aniso: 8, angular: 400 },
  high: { cloudDiv: 2, steps: 96, lightSteps: 6, lightDetail: 3, blend: 0.3, msaa: 4, hdr: 'rgba16f', check: false, fft: [256, 256, 256, 256], aniso: 16, angular: 640 },
}[params.get('q') || (RENDER_MODE ? 'high' : 'rt')];

export class App {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = createGL(canvas, { preserve: RENDER_MODE }));
    this.weather = new Weather(params.get('preset') || 'breeze');
    if (params.has('elev')) this.weather.set('sunElev', Number(params.get('elev')));
    if (params.has('az')) this.weather.set('sunAz', Number(params.get('az')));
    for (const k of Object.keys(this.weather.target)) if (params.has(k)) this.weather.set(k, Number(params.get(k)));
    this.weather.snap();

    this.ocean = new Ocean(gl, QUALITY.fft);
    this.water = new Water(gl, { angular: QUALITY.angular });
    this.foam = new FoamTexture(gl);
    this.probe = new OceanProbe(gl);
    this.rain = new Rain(gl);
    this.lightning = new Lightning(gl);
    this.spray = new Spray(gl);
    this.atmo = new Atmosphere(gl);
    this.sky = new Sky(gl);
    this.clouds = new Clouds(gl);
    this.windOffset = [Number(params.get('cx') || 0), 0, Number(params.get('cz') || 0)];
    this.post = new Post(gl);
    this.prof = new Profiler(gl, params.has('profile'));
    if (params.has('profile2')) this.ocean.prof = this.prof;

    // placeholders until the cloud system provides real data
    this.white = new Texture(gl, { w: 1, h: 1, format: 'rgba8', data: new Uint8Array([255, 255, 255, 255]) });
    this.clear = new Texture(gl, { w: 1, h: 1, format: 'rgba16f', data: new Float32Array([0, 0, 0, 1]) });

    this.cam = {
      eye: Number(params.get('h') || 4),   // metres above the (local) sea surface
      base: [0, 0],                         // anchor position (xz)
      heave: 0, roll: 0, tilt: 0,
      float: params.get('float') !== '0',
      pos: [0, Number(params.get('h') || 4), 0],
      yaw: Number(params.get('yaw') || 200) * Math.PI / 180,
      pitch: Number(params.get('pitch') || -4) * Math.PI / 180,
      fov: Number(params.get('fov') || 42) * Math.PI / 180,
    };
    this.time = Number(params.get('t') || 0);
    this.scale = Number(params.get('scale') || Math.min(window.devicePixelRatio || 1, 1.5));
    this.msaa = Number(params.get('msaa') || QUALITY.msaa);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindInput();
  }

  resize(w, h) {
    const gl = this.gl;
    w = w || Math.round(this.canvas.clientWidth * this.scale);
    h = h || Math.round(this.canvas.clientHeight * this.scale);
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    this.ms = new MSTarget(gl, w, h, this.msaa, QUALITY.hdr);
    this.hdr = new Texture(gl, { w, h, format: 'rgba16f' });
    this.hdrTarget = new Target(gl, [this.hdr]);
    this.post.resize(w, h);
    this.clouds.resize(w, h, QUALITY.cloudDiv);
  }

  bindInput() {
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const k = 0.0035 * (this.cam.fov / 0.73);
      this.cam.yaw += (e.clientX - drag.x) * k;
      this.cam.pitch = clamp(this.cam.pitch - (e.clientY - drag.y) * k, -1.2, 1.2);
      drag = { x: e.clientX, y: e.clientY };
    });
    this.canvas.addEventListener('pointerup', () => { drag = null; });
    this.canvas.addEventListener('wheel', (e) => {
      this.cam.eye = clamp(this.cam.eye * Math.exp(e.deltaY * 0.001), 1.5, 400);
    }, { passive: true });
  }

  // Floating camera: heave, pitch and roll with the sea (a small boat responds to waves longer
  // than itself, so the probe samples a mip level matching an ~8 m hull).
  updateCamera(dt) {
    const c = this.cam;
    const ot = this.ocean.textures();
    const r = this.probe.run(ot, c.base, 8, RENDER_MODE);
    const f = c.float ? 1 - Math.min(Math.max((c.eye - 12) / 28, 0), 1) : 0;
    const k = 1 - Math.exp(-dt * 5);
    c.heave += (r.height * f - c.heave) * k;
    const fx = Math.cos(c.yaw), fz = Math.sin(c.yaw);
    const along = r.sx * fx + r.sz * fz, across = -r.sx * fz + r.sz * fx;
    c.tilt += (Math.atan(along) * 0.55 * f - c.tilt) * k;
    c.roll += (Math.atan(across) * 0.55 * f - c.roll) * k;
    c.pos = [c.base[0] + r.dx * f * 0.8, c.eye + c.heave, c.base[1] + r.dz * f * 0.8];
  }

  cameraMatrices() {
    const { yaw, fov, pos } = this.cam;
    const pitch = this.cam.pitch + this.cam.tilt;
    const fwd = [Math.cos(pitch) * Math.cos(yaw), Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)];
    const right0 = v3.norm(v3.cross(fwd, [0, 1, 0]));
    const up0 = v3.cross(right0, fwd);
    const cr = Math.cos(this.cam.roll), sr = Math.sin(this.cam.roll);
    const right = v3.norm(v3.add(v3.scale(right0, cr), v3.scale(up0, sr)));
    const up = v3.cross(right, fwd);
    const view = viewFromBasis(pos, right, up, v3.scale(fwd, -1));
    const proj = perspective(fov, this.w / this.h, 0.2, 80000);
    const vp = mul(proj, view);
    return { view, proj, vp, inv: invert(vp), fwd };
  }

  frame(dt) {
    const gl = this.gl;
    this.time += dt;
    const t = this.time;
    const W = this.weather;
    W.update(dt);
    const S = W.state;
    const sun = W.sunDir();

    const P = this.prof;
    P.poll();
    P.begin('ocean');
    this.ocean.lambda = S.choppy;
    this.ocean.setSpectrum(W.spectrum());
    this.ocean.update(t, dt, W.foam());
    const stats = this.ocean.stats;

    this.updateCamera(dt);
    P.section('atmosphere');
    const camH = this.cam.pos[1];
    this.atmo.update(sun, camH, S.haze);

    const M = this.cameraMatrices();
    // squall front: world-space line ahead of the camera; weather blends across it
    const fOn = S.front > 0.5;
    const faz = (S.frontAz * Math.PI) / 180;
    const fn = [Math.cos(faz), Math.sin(faz)];
    const fz = this.cam.pos[0] * fn[0] + this.cam.pos[2] * fn[1] + S.frontDist;
    const mCam = fOn ? smoothstep(-S.frontWidth, S.frontWidth, -S.frontDist) : 0;
    const L = {
      rain: S.rain + (S.sRain - S.rain) * mCam,
      clouds: S.clouds + (S.sClouds - S.clouds) * mCam,
      dark: S.cloudDark + (S.sDark - S.cloudDark) * mCam,
      mist: S.mist + (S.sMist - S.mist) * mCam,
    };
    this.local = L;
    const skyU = {
      uSkyView: this.atmo.skyView, uAerialL: this.atmo.aerialL, uAerialT: this.atmo.aerialT,
      uTransmittance: this.atmo.transmittance, uSunDir: sun, uAerialMax: this.atmo.maxDist,
      uIrradiance: this.sky.irradiance, uCamHkm: camH / 1000,
      // fraction of direct sun reaching the haze/rain below the clouds (a thick deck blocks it all)
      uHazeSun: (1 - smoothstep(0.3, 0.9, L.clouds)) * (1 - 0.85 * L.dark) * 0.97 + 0.03 * (1 - L.dark),
    };
    // lightning: flash intensity drives cloud emission, sky/sea illumination and thunder
    if (params.has('strikeAt') && t >= Number(params.get('strikeAt')) && !this.forcedStrike) {
      this.forcedStrike = true;
      this.lightning.trigger(this.cam, { dist: Number(params.get('sdist') || 3500), az: this.cam.yaw + Number(params.get('saz') || 0.15), ground: true, base: S.cloudBase });
    }
    const flash = this.lightning.update(dt, S.lightning, this.cam, S.cloudBase);
    const lp = this.lightning.pos;
    const ldist = Math.hypot(lp[0] - this.cam.pos[0], lp[2] - this.cam.pos[2]);
    const flashE = flash * 0.012 / (1 + (ldist / 2500) ** 2);
    const flashRGB = [0.8 * flashE, 0.85 * flashE, 1.0 * flashE];
    // rain extinction: visibility ~ 3.9/beta drops from >20 km to ~1.5 km in a downpour
    const fogDensity = S.mist * 1.2e-3 + S.rain * 1.6e-3;
    const stormFog = S.sMist * 1.2e-3 + S.sRain * 1.6e-3;
    const fogU = {
      uFogDensity: fogDensity, uFogTop: fOn ? Math.min(S.cloudBase, S.sBase) : S.cloudBase,
      uFogFront: fOn ? [fn[0], fn[1], fz, S.frontWidth] : [1, 0, 0, 0], uFogStorm: [stormFog, 0.55],
      uFogCam: [this.cam.pos[0], this.cam.pos[2]],
    };

    // clouds advect with the wind aloft (~1.6x surface wind), detail evolves slowly
    const wd0 = (S.windDir * Math.PI) / 180;
    const aloft = 4 + S.wind * 1.6;
    this.windOffset[0] += Math.cos(wd0) * aloft * dt;
    this.windOffset[2] += Math.sin(wd0) * aloft * dt;
    this.windOffset[1] += dt * (3 + S.wind * 0.6);
    const cloudU = {
      windOffset: this.windOffset, coverage: S.clouds, base: S.cloudBase,
      top: S.cloudBase + 1800 + S.cloudDark * 5200, density: 0.11 - S.cloudDark * 0.05, dark: S.cloudDark,
      front: fOn ? [fn[0], fn[1], fz, S.frontWidth] : [1, 0, 0, 0],
      stormA: [S.sClouds, S.sDark, 0.11 - S.sDark * 0.05, S.sBase], stormTop: S.sBase + 1800 + S.sDark * 5200,
      flash: [lp[0], lp[1], lp[2], flash * 0.6], flashColor: [0.75, 0.8, 1.0], blend: flash > 0.02 ? 0.85 : QUALITY.blend, steps: QUALITY.steps,
      lightSteps: QUALITY.lightSteps, lightDetail: QUALITY.lightDetail, check: QUALITY.check,
    };
    P.section('clouds');
    this.clouds.render(skyU, cloudU, { pos: this.cam.pos, inv: M.inv, vp: M.vp });
    P.section('env');
    this.sky.renderEnv({ ...skyU, ...fogU, uCloudsEnv: this.clouds.env, uCloudsOn: 1, uSunVis: 1 });

    // main HDR pass
    P.section('sky');
    this.ms.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    this.sky.drawBackground({ ...skyU, ...fogU, uInvViewProj: M.inv, uCamPos: this.cam.pos, uClouds: this.clouds.screen, uCloudsOn: 1, uSunVis: 1 });

    P.section('water');
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    const ot = this.ocean.textures();
    const wd = (S.windDir * Math.PI) / 180;
    this.waterUniforms = {
      ...skyU, ...fogU,
      uViewProj: M.vp, uCamPos: this.cam.pos,
      uDisp: ot.disp.slice(0, 3), uSlope: ot.slope, uSize: ot.sizes, uTexel: ot.texels, uDispScale: 1,
      uEnv: this.sky.env, uCloudShadow: this.clouds.shadow, uShadowRect: this.clouds.shadowRect,
      uUnresolved: stats.unresolved, uHs: stats.hs,
      uRrs: mixv([0.00022, 0.0019, 0.0088], [0.0011, 0.0032, 0.0046], smoothstep(9, 24, S.wind)), uSSS: [0.004, 0.05, 0.042],
      uFoamAmount: 1, uTime: t, uRain: L.rain, uFlash: flashRGB,
      uFoamTex: this.foam.tex, uWindDir: [Math.cos(wd), Math.sin(wd)], uFoamStretch: Math.min(Math.max((S.wind - 11) / 10, 0), 1), uDebug: 0,
    };
    this.water.draw(this.waterUniforms);

    P.section('rain');
    const pixelAngle = this.cam.fov / this.h;
    const fxU = { viewProj: M.vp, camPos: this.cam.pos, pixelAngle };
    this.lightning.draw({ ...fxU, fogDensity });
    const windVec = [Math.cos(wd) * S.wind, Math.sin(wd) * S.wind];
    this.spray.draw({ ...fxU, skyU, time: t, wind: S.wind, windVec, disp: ot.disp.slice(0, 3), sizes: ot.sizes, flash: flashRGB });
    this.rain.draw({
      ...fxU, skyU, rain: L.rain, time: t, exposure: 1 / 60,
      wind: [Math.cos(wd) * S.wind * 0.8, Math.sin(wd) * S.wind * 0.8],
      viewport: [this.w, this.h], env: this.sky.env, flash: flashRGB,
      disp: ot.disp.slice(0, 3), sizes: ot.sizes,
    });
    gl.disable(gl.DEPTH_TEST);
    this.ms.resolve(this.hdrTarget);

    P.section('post');
    this.post.run(this.hdr, dt, {
      time: t, bloom: 0.05, exposureBias: Number(params.get('ev') || 0),
      skyU, cloudShadow: this.clouds.shadow, incident: 0.75, fade: this.fade ?? 1,
    });
    P.end();
    this.stats = stats;
    this.flash = flash;
    this.thunderEvents = this.lightning.events.splice(0);
  }

  // Film: drive weather + camera from the timeline at time t (seconds), deterministic.
  filmFrame(t, dt) {
    const act = film.actAt(Math.max(t, 0));
    if (this.filmAct !== undefined && act !== this.filmAct) {
      // new shot: settle foam, clouds and camera filters off-screen (during the dip to black)
      this.filmAct = act;
      const t0 = film.acts[act].start;
      for (let w = t0 - 3; w < t0 - dt / 2; w += dt) this.filmFrame(w < t0 ? t0 : w, dt);
    }
    this.filmAct = act;
    this.fade = film.fadeAt(t);
    const W = this.weather;
    const w = film.weatherAt(Math.max(t, 0));
    for (const k in w) {
      if (k in W.time) { W.time[k] = w[k]; W.timeTarget[k] = w[k]; }
      else { W.state[k] = w[k]; W.target[k] = w[k]; }
    }
    W.transition = 1e-6;
    const c = film.cameraAt(Math.max(t, 0));
    this.cam.yaw = (c.yaw * Math.PI) / 180;
    this.cam.pitch = (c.pitch * Math.PI) / 180;
    this.cam.eye = c.eye;
    this.cam.fov = (c.fov * Math.PI) / 180;
    for (const s of film.strikes) {
      if (s.t > t - dt && s.t <= t) this.lightning.trigger(this.cam, { dist: s.dist, az: this.cam.yaw + s.rel, ground: s.ground, base: W.state.cloudBase });
    }
    this.time = t - dt;
    this.frame(dt);
  }

  // Film soundtrack (OfflineAudioContext), returned as a WAV ArrayBuffer.
  async filmAudio() {
    const paramsAt = (t) => {
      const w = film.weatherAt(t);
      const hs = 0.21 * w.wind * w.wind / 9.81 + w.swellHs * 0.5;
      const mc = w.front > 0.5 ? smoothstep(-w.frontWidth, w.frontWidth, -w.frontDist) : 0;
      return { wind: w.wind, rain: w.rain + ((w.sRain ?? 0) - w.rain) * mc, hs, tp: (2 * Math.PI * Math.max(w.wind, 1)) / (0.855 * 9.81), foam: Math.min(2 * 3.84e-6 * Math.pow(w.wind, 3.41), 0.4) };
    };
    const strikes = film.strikes.map((s) => ({ t: s.t, dist: s.dist, power: s.power }));
    const buf = await renderSoundtrack(film.duration, paramsAt, strikes);
    return encodeWav(buf);
  }

  // Debug: fraction of the sea surface covered by foam, measured from a top-down render.
  measureFoam() {
    const gl = this.gl;
    const pos = [this.cam.pos[0], 120, this.cam.pos[2]];
    const right = [1, 0, 0], up = [0, 0, -1], back = [0, 1, 0];
    const view = viewFromBasis(pos, right, up, back);
    const proj = perspective(1.0, this.w / this.h, 1, 1000);
    this.hdrTarget.bind();
    gl.disable(gl.DEPTH_TEST);
    this.water.draw({ ...this.waterUniforms, uViewProj: mul(proj, view), uCamPos: pos, uDebug: 1 });
    const px = new Float32Array(this.w * this.h * 4);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.FLOAT, px);
    let s = 0, raw = 0;
    for (let i = 0; i < px.length; i += 4) { s += px[i]; raw += px[i + 1]; }
    const n = px.length / 4;
    return { coverage: s / n, raw: raw / n };
  }
}

const canvas = document.getElementById('c');
let app;
try {
  app = new App(canvas);
  window.app = app;
} catch (e) {
  document.body.insertAdjacentHTML('beforeend', `<pre class="err">${e.message}</pre>`);
  throw e;
}

// Live audio: created on the first user gesture (browsers block autoplay).
const audio = {
  engine: new AudioEngine(),
  ctx: null,
  async enable(on) {
    if (on && !this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'playback' });
      await this.engine.init(this.ctx);
    }
    if (!this.ctx) return;
    if (on) await this.ctx.resume(); else await this.ctx.suspend();
  },
  update(app) {
    const e = this.engine;
    if (!this.ctx) return;
    const S = app.weather.state;
    e.set({
      wind: S.wind, rain: S.rain, hs: app.stats ? app.stats.hs : 2,
      tp: (2 * Math.PI * Math.max(S.wind, 1)) / (0.855 * 9.81),
      foam: Math.min(2 * 3.84e-6 * Math.pow(S.wind, 3.41), 0.4),
    });
    e.tick();
    for (const ev of app.thunderEvents || []) e.thunder(this.ctx.currentTime, ev.dist, ev.power);
  },
};

if (!RENDER_MODE) {
  const style = document.createElement('style');
  style.textContent = UI_CSS;
  document.head.appendChild(style);
  app.ui = new UI(app, audio);
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    app.frame(dt);
    audio.update(app);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
