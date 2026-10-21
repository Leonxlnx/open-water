import { createGL, Texture, Target, MSTarget } from './gl.js';
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
  rt: { cloudDiv: 3, steps: 44, lightSteps: 4, lightDetail: 1, blend: 0.14, msaa: 4, hdr: 'r11g11b10f', check: true, fft: [256, 256, 128, 128], angular: 400, upSteps: 2 },
  ultra: { cloudDiv: 1, steps: 128, lightSteps: 6, lightDetail: 3, blend: 0.08, msaa: 4, hdr: 'rgba16f', check: false, fft: [512, 256, 256, 256], angular: 640, upSteps: 4 },
  high: { cloudDiv: 1, steps: 96, lightSteps: 6, lightDetail: 3, blend: 0.08, msaa: 4, hdr: 'rgba16f', check: false, fft: [512, 256, 256, 256], angular: 640, upSteps: 4 },
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

    this.cam = {
      eye: Number(params.get('h') || 3),   // metres above the (local) sea surface
      base: [0, 0],                         // anchor position (xz)
      heave: 0, roll: 0, tilt: 0,
      float: params.get('float') !== '0',
      pos: [0, Number(params.get('h') || 4), 0],
      yaw: Number(params.get('yaw') || 200) * Math.PI / 180,
      pitch: Number(params.get('pitch') ?? 1.5) * Math.PI / 180,
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
    this.ms?.dispose();
    this.hdrTarget?.dispose();
    this.hdr?.dispose();
    this.canvas.width = w; this.canvas.height = h;
    this.ms = new MSTarget(gl, w, h, this.msaa, [QUALITY.hdr, 'rgba16f']);
    // the resolve target must match the multisample format exactly (blit resolve rule)
    this.hdr = new Texture(gl, { w, h, format: this.ms.format });
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

  // Advance only the sea (spectrum, FFT, foam) without rendering: brings long-lived foam to its
  // steady state quickly before a still is taken.
  warmSea(seconds, dt = 1 / 30) {
    const W = this.weather;
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      this.time += dt;
      W.update(dt);
      const S = W.state;
      this.ocean.lambda = Math.max(S.choppy, W.choppyFor(S.wind));
      const wdr = (S.windDir * Math.PI) / 180;
      this.ocean.drift = [Math.cos(wdr) * 0.035 * S.wind, Math.sin(wdr) * 0.035 * S.wind];
      this.ocean.setSpectrum(W.spectrum());
      this.ocean.update(this.time, dt, W.foam());
      if (i % 30 === 29) this.gl.finish();
    }
  }

  frame(dt) {
    const gl = this.gl;
    this.time += dt;
    const t = this.time;
    const W = this.weather;
    W.update(dt);
    const S = W.state;
    const night = W.time.sunElev < -7;
    const sun = night ? W.moonDir() : W.sunDir();
    // Moonlight is rendered at unit scale (it would underflow fp16); night is made in exposure.
    const lightScale = 1;
    const lightMag = night ? -12.7 : -26.74;
    // the light source switched (sun <-> moon): temporal cloud history is meaningless now
    if (this.night !== undefined && this.night !== night) this.clouds.reset = true;
    this.night = night;

    const P = this.prof;
    P.poll();
    P.begin('ocean');
    this.ocean.lambda = Math.max(S.choppy, W.choppyFor(S.wind));
    // wind drift of surface foam ~3% of U10 (plus a little Stokes drift)
    const wdr = (S.windDir * Math.PI) / 180;
    this.ocean.drift = [Math.cos(wdr) * 0.035 * S.wind, Math.sin(wdr) * 0.035 * S.wind];
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
    const fAlong = -this.cam.pos[0] * fn[1] + this.cam.pos[2] * fn[0];
    const fCurve = 1400 * Math.sin(fAlong / 7000) + 650 * Math.sin(fAlong / 2900 + 1.3);
    const mCam = fOn ? smoothstep(-S.frontWidth, S.frontWidth, -S.frontDist - fCurve) : 0;
    const L = {
      rain: S.rain + (S.sRain - S.rain) * mCam,
      clouds: S.clouds + (S.sClouds - S.clouds) * mCam,
      dark: S.cloudDark + (S.sDark - S.cloudDark) * mCam,
      mist: S.mist + (S.sMist - S.mist) * mCam,
    };
    this.local = L;
    const skyU = {
      uSkyView: this.atmo.skyView, uAerialL: this.atmo.aerialL, uExtRatio: this.atmo.extRatio,
      uTransmittance: this.atmo.transmittance, uSunDir: sun, uAerialMax: this.atmo.maxDist,
      uIrradiance: this.sky.irradiance, uCamHkm: camH / 1000, uLightScale: lightScale, uLightMag: lightMag,
      // fraction of direct sun reaching the haze/rain below the clouds (a thick deck blocks it all)
      // (a closed deck lets no direct sun through: the floor is for broken cloud only)
      uHazeSun: (1 - smoothstep(0.3, 0.9, L.clouds)) * (1 - 0.85 * L.dark) * 0.97 + 0.03 * (1 - L.dark) * (1 - smoothstep(0.8, 0.9, L.clouds)),
    };
    // lightning: flash intensity drives cloud emission, sky/sea illumination and thunder
    if (params.has('strikeAt') && t >= Number(params.get('strikeAt')) && !this.forcedStrike) {
      this.forcedStrike = true;
      this.lightning.trigger(this.cam, { dist: Number(params.get('sdist') || 3500), az: this.cam.yaw + Number(params.get('saz') || 0.15), ground: true, base: S.cloudBase });
    }
    const flash = this.lightning.update(dt, S.lightning, this.cam, S.cloudBase);
    const lp = this.lightning.pos;
    const ldist = Math.hypot(lp[0] - this.cam.pos[0], lp[2] - this.cam.pos[2]);
    // Illuminance of a stroke ~ I / d^2 with I ~ 1e8 cd (about 100 lux at 1 km), relative to the
    // light source: sunlight ~1e5 lux, full moonlight ~0.25 lux. In daylight a strike barely lights
    // the scene; at night it outshines the moon.
    const srcLux = night ? 0.25 : 1e5;
    const flashE = Math.min(flash * 1e8 / (ldist * ldist + 300 * 300) / srcLux, 6);
    const flashRGB = [0.8 * flashE, 0.85 * flashE, 1.0 * flashE];
    const lv = [lp[0] - this.cam.pos[0], (night ? lp[1] * 0.3 : lp[1] * 0.5) - this.cam.pos[1], lp[2] - this.cam.pos[2]];
    const flashDir = v3.norm(lv);
    // rain extinction: visibility ~ 3.9/beta drops from >20 km to ~1.5 km in a downpour
    const rainBeta = (r) => (r > 0.002 ? 0.336e-3 * Math.pow(r * 50, 0.63) : 0);
    const fogDensity = S.mist * 1.2e-3 + rainBeta(S.rain);
    const stormFog = S.sMist * 1.2e-3 + rainBeta(S.sRain);
    const fogU = {
      uFogDensity: fogDensity, uFogTop: fOn ? (S.cloudBase + S.sBase) * 0.5 + 100 : S.cloudBase + 100,
      uFogFront: fOn ? [fn[0], fn[1], fz, S.frontWidth] : [1, 0, 0, 0],
      uFogStorm: [stormFog, (night ? 0.65 : 0.3) + (0.6 - (night ? 0.65 : 0.3)) * mCam, (fogDensity + mCam * Math.max(stormFog - fogDensity, 0)) * (fOn ? (S.cloudBase + S.sBase) * 0.5 + 100 : S.cloudBase + 100)],
      uFogCam: [this.cam.pos[0], this.cam.pos[2]],
      uFlashFog: flashRGB.map((x) => x * 0.25), uFlashDir: flashDir,
      // spray haze from breaking crests: grows from a near gale (~14 m/s) upwards
      uSprayHaze: [smoothstep(12, 26, S.wind) * 1.2e-3, Math.max(this.cam.pos[1], 0.5)],
    };

    // clouds advect with the wind aloft (~1.6x surface wind), detail evolves slowly
    const wd0 = (S.windDir * Math.PI) / 180;
    const aloft = 4 + S.wind * 1.6;
    this.windOffset[0] += Math.cos(wd0) * aloft * dt;
    this.windOffset[2] += Math.sin(wd0) * aloft * dt;
    this.windOffset[1] += dt * (3 + S.wind * 0.6);
    // the film's squall front sweeps in time-lapse (km per second): a long cloud history lags behind it
    // as echo bands, so the history shortens with the front's motion per frame
    const frontStep = fOn && this.prevFrontDist !== undefined ? Math.abs(S.frontDist - this.prevFrontDist) : 0;
    this.prevFrontDist = S.frontDist;
    const frontBlend = 0.45 * smoothstep(3, 40, frontStep);
    const cloudU = {
      windOffset: this.windOffset, coverage: S.clouds, base: S.cloudBase,
      top: S.cloudBase + 1800 + S.cloudDark * 5200, density: 0.11 - S.cloudDark * 0.05, dark: S.cloudDark,
      front: fOn ? [fn[0], fn[1], fz, S.frontWidth] : [1, 0, 0, 0],
      stormA: [S.sClouds, S.sDark, 0.11 - S.sDark * 0.05, S.sBase], stormTop: S.sBase + 2500 + S.sDark * 8000, // cumulonimbus tops ~9-10 km
      flash: [lp[0], lp[1], lp[2], flash * (night ? 30 : 0.025)], flashColor: [0.75, 0.8, 1.0], blend: Math.max(QUALITY.blend + (0.85 - QUALITY.blend) * smoothstep(0.02, 0.3, flash), frontBlend), steps: QUALITY.steps,
      lightSteps: QUALITY.lightSteps, lightDetail: QUALITY.lightDetail, check: QUALITY.check, upSteps: QUALITY.upSteps,
      shapeLod: params.has('shapelod') ? Number(params.get('shapelod')) : -1,
    };
    P.section('clouds');
    // a flash changes the cloud light within a frame, so most of the history is dropped; the offline
    // tiers then average several independently jittered passes instead of showing one noisy sample
    // (two: a heavier frame risks GPU driver timeouts on integrated GPUs)
    const cloudPasses = flash > 0.02 && !QUALITY.check ? 2 : 1;
    for (let k = 0; k < cloudPasses; k++) {
      const b = cloudU.blend;
      this.clouds.render(skyU, { ...cloudU, blend: b / (1 + k * b) }, { pos: this.cam.pos, inv: M.inv, vp: M.vp, fov: this.cam.fov });
    }
    P.section('env');
    // crepuscular rays: haze scattering below the cloud base, shadowed by the cloud-shadow map
    Object.assign(skyU, {
      uShaftShadow: this.clouds.shadow, uShaftRect: this.clouds.shadowRect,
      uShaft: [this.atmo.uniforms.uMie[0] * 1e-3, Math.min(S.cloudBase, fOn ? S.sBase : 1e9), S.clouds > 0.05 ? 1.0 : 0.0, (this.time * 0.618) % 1],
    });
    // water-leaving reflectance: deep blue, greyer with bubbles in a high wind, grey-green in rain
    const rrs = mixv(mixv([0.0004, 0.0030, 0.0085], [0.0012, 0.0026, 0.0022], 0.8 * smoothstep(5, 24, S.wind)), [0.0013, 0.0024, 0.0025], smoothstep(0.1, 0.8, L.rain));
    this.sky.renderEnv({ ...skyU, ...fogU, uCloudsEnv: this.clouds.env, uCloudsOn: 1, uSunVis: 1, uEnvRrs: rrs });

    // main HDR pass
    P.section('sky');
    this.ms.bind();
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.DEPTH_TEST);
    this.sky.drawBackground({ ...skyU, ...fogU, uInvViewProj: M.inv, uCamPos: this.cam.pos, uClouds: this.clouds.screen, uCloudDepth: this.clouds.depth, uCloudsOn: 1, uSunVis: 1,
      uIsMoon: night ? 1 : 0, uPixelAngle: this.cam.fov / this.h, uTime: t });

    P.section('water');
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    const ot = this.ocean.textures();
    const wd = (S.windDir * Math.PI) / 180;
    this.gustDrift = this.gustDrift || [0, 0];
    this.gustDrift[0] += Math.cos(wd) * S.wind * 0.9 * dt;
    this.gustDrift[1] += Math.sin(wd) * S.wind * 0.9 * dt;
    this.waterUniforms = {
      ...skyU, ...fogU,
      uViewProj: M.vp, uCamPos: this.cam.pos,
      uDisp: ot.disp.slice(0, 3), uSlope: ot.slope, uActive: ot.active[1], uActive0: ot.active[0], uLongSlope: Math.max(Math.sqrt(stats.bandMss[0] * 0.6), 0.01), uGlintArea: 2e-5, uGlintExp: night ? 10 : 1, uSize: ot.sizes, uTexel: ot.texels, uDispScale: 1,
      uEnv: this.sky.env, uCloudShadow: this.clouds.shadow, uShadowRect: this.clouds.shadowRect,
      uUnresolved: stats.unresolved, uMssTotal: Math.max(stats.coxMunk, stats.resolvedMss + stats.unresolved), uHs: stats.hs,
      uRrs: rrs, uSSS: [0.004, 0.05, 0.042],
      uGust: [0.25 + 0.4 * smoothstep(1.5, 4, S.wind) * (1 - smoothstep(6, 12, S.wind)), this.gustDrift[0], this.gustDrift[1]],
      uFoamAmount: params.has('nofoam') ? 0 : 1, uFoamLace: smoothstep(14, 22, S.wind) * 0.45, uDbgMask: (params.get('dbg') || '1,1,1').split(',').map(Number), uTime: t, uRain: L.rain, uFlash: flashRGB,
      // a visible ground strike: channel foot xz, cloud base, channel radiance (as drawn, through the rain)
      uBolt: this.lightning.ground && this.lightning.bolt > 0.01 && this.lightning.strike?.ground
        ? [this.lightning.ground[0], this.lightning.ground[1], this.lightning.ground[2], this.lightning.bolt * 2600 * (this.boltT ?? 1)] : [0, 0, 0, 0],
      uFoamTex: this.foam.tex, uWindDir: [Math.cos(wd), Math.sin(wd)], uFoamStretch: Math.min(Math.max((S.wind - 10) / 8, 0), 1), uDebug: 0,
    };
    this.water.draw(this.waterUniforms);

    P.section('rain');
    this.rainDrift = this.rainDrift || [0, 0];
    this.rainDrift[0] += Math.cos(wd) * S.wind * 0.8 * dt;
    this.rainDrift[1] += Math.sin(wd) * S.wind * 0.8 * dt;
    const pixelAngle = this.cam.fov / this.h;
    const fxU = { viewProj: M.vp, camPos: this.cam.pos, pixelAngle };
    // bolt seen through the rain: base fog plus the storm side's curtains along the path
    {
      const s0 = -S.frontDist - fCurve, sB = s0 + (lv[0] * fn[0] + lv[2] * fn[1]);
      const inside = fOn ? (sB === s0 ? (s0 > 0 ? 1 : 0) : Math.min(Math.max((Math.max(sB, 0) - Math.max(s0, 0)) / (sB - s0), 0), 1)) : 0;
      this.boltT = Math.exp(-(fogDensity * ldist + Math.max(stormFog - fogDensity, 0) * ldist * inside * 0.8));
    }
    this.lightning.draw({ ...fxU, fogDensity: 0, transmit: this.boltT, base: fOn ? Math.min(S.cloudBase, S.sBase) : S.cloudBase });
    const windVec = [Math.cos(wd) * S.wind, Math.sin(wd) * S.wind];
    this.spray.draw({ ...fxU, skyU, anchor: this.cam.base, time: t, wind: S.wind, windVec, disp: ot.disp.slice(0, 3), active: ot.active[1], sizes: ot.sizes, flash: flashRGB });
    this.rain.draw({
      ...fxU, skyU, rain: L.rain, time: t, exposure: 1 / 60,
      wind: [Math.cos(wd) * S.wind * 0.8, Math.sin(wd) * S.wind * 0.8],
      viewport: [this.w, this.h], env: this.sky.env, flash: flashRGB, drift: this.rainDrift,
      disp: ot.disp.slice(0, 3), sizes: ot.sizes,
    });
    gl.disable(gl.DEPTH_TEST);
    this.ms.resolve(this.hdrTarget);

    // shooting into a low sun a photographer meters the bright sky (scene), not the incident light
    const fh = Math.hypot(M.fwd[0], M.fwd[2]) || 1;
    const backlit = night ? 0 : smoothstep(0.55, 0.95, (M.fwd[0] * sun[0] + M.fwd[2] * sun[2]) / fh / (Math.hypot(sun[0], sun[2]) || 1)) * (1 - smoothstep(12, 35, W.time.sunElev)) * (1 - L.clouds * 0.8);
    P.section('post');
    // how much of the frame a storm fills (overhead, or a squall line in view)
    const stormView = Math.max(smoothstep(0.7, 0.9, L.clouds), fOn ? smoothstep(15000, 3000, S.frontDist) : 0);
    this.post.run(this.hdr, dt, {
      time: t, bloom: 0.012 + 0.006 * backlit + 0.01 * (night ? 1 : 0), // a camera's matrix meter lifts a frame dominated by a dark sea under a high sun
      exposureBias: Number(params.get('ev') || 0) - 0.9 * backlit - 1.0 * L.dark * L.dark * (0.4 + 0.6 * L.rain) + 0.4 * (1 - smoothstep(0.2, 0.4, L.clouds)) * smoothstep(35, 50, W.time.sunElev),
      skyU, cloudShadow: this.clouds.shadow, incident: 0.65 * (1 - backlit), fade: this.fade ?? 1, whiteBalance: params.has('wb') ? Number(params.get('wb')) : (0.1 * smoothstep(0.25, 0.6, L.clouds) + 0.35 * smoothstep(0.8, 0.95, L.clouds)) * (1 - backlit) * (night ? 0 : 1), night: night ? 1 : 0,
      look: params.has('look') ? params.get('look').split(',').map(Number) : night ? [1.35, 0.4, 1.0, 0.004] : mixv([1.5, 0.4, 1.0, 0.004], [1.6, 0.36, 0.95, 0.03], stormView),
      look2: night ? [1.5, 1.0] : [1.8 - 0.3 * stormView, 1.03 + 0.05 * backlit * (1 - stormView)],
    });
    P.end();
    this.stats = stats;
    this.flash = flash;
    this.thunderEvents = this.lightning.events.splice(0);
  }

  // Film: drive weather + camera from the timeline at time t (seconds), deterministic.
  filmFrame(t, dt, hold) {
    // hold: sample the timeline at this time while the clock (waves, foam, clouds) runs on t
    const tl = Math.max(hold ?? t, 0);
    const act = film.actAt(tl);
    if (this.filmAct !== undefined && act !== this.filmAct) {
      // new shot: settle foam, clouds and camera filters off-screen (during the dip to black)
      this.filmAct = act;
      const t0 = film.acts[act].start;
      // the new shot's wind has been blowing for a while: its foam history first (25 s, waves only)
      this.filmFrame(t0 - 28, dt, t0);
      this.warmSea(25, dt);
      // (the GPU drains after every frame: a long queue of heavy frames trips the driver's watchdog)
      for (let w = t0 - 3; w < t0 - dt / 2; w += dt) { this.filmFrame(w, dt, t0); this.gl.finish(); }
    }
    this.filmAct = act;
    this.fade = film.fadeAt(tl);
    const W = this.weather;
    const w = film.weatherAt(tl);
    // debug: ?fo=clouds:0.1,haze:1 overrides timeline values
    if (params.has('fo')) for (const kv of params.get('fo').split(',')) { const [k, v] = kv.split(':'); w[k] = Number(v); }
    for (const k in w) {
      if (k in W.time) { W.time[k] = w[k]; W.timeTarget[k] = w[k]; }
      else { W.state[k] = w[k]; W.target[k] = w[k]; }
    }
    W.transition = 1e-6;
    const c = film.cameraAt(tl);
    this.cam.yaw = (c.yaw * Math.PI) / 180;
    this.cam.pitch = (c.pitch * Math.PI) / 180;
    this.cam.eye = c.eye;
    this.cam.fov = (c.fov * Math.PI) / 180;
    // strikes fire once when the timeline passes them (robust to float time steps and repeats)
    const prev = this.filmPrevT ?? t - dt;
    if (hold === undefined) this.filmPrevT = t;
    for (const s of film.strikes) {
      if (hold === undefined && s.t > prev && s.t <= t) this.lightning.trigger(this.cam, { dist: s.dist, az: this.cam.yaw + s.rel, ground: s.ground, base: W.state.cloudBase });
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
    // sound follows the picture fades, but only dips (not silence) at the cut between acts
    const gainAt = (t) => Math.max(film.fadeAt(t), film.acts.slice(1).some((a) => Math.abs(t - a.start) < 1) ? 0.35 : 0);
    const buf = await renderSoundtrack(film.duration, paramsAt, strikes, 48000, gainAt);
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
    let s = 0, raw = 0, a = 0;
    // whitecap coverage as photographs measure it: pixels where the foam is more than half opaque
    // (a: stage A, the actively breaking part)
    for (let i = 0; i < px.length; i += 4) { s += px[i] > 0.5 ? 1 : 0; raw += px[i + 1]; a += px[i + 2] > 0.5 ? 1 : 0; }
    const n = px.length / 4;
    return { coverage: s / n, raw: raw / n, active: a / n };
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
    // muted (suspended) context: drop thunder instead of queueing it for the unmute
    if (this.ctx.state === 'running') for (const ev of app.thunderEvents || []) e.thunder(this.ctx.currentTime, ev.dist, ev.power);
  },
};

if (!RENDER_MODE) {
  const style = document.createElement('style');
  style.textContent = UI_CSS;
  document.head.appendChild(style);
  app.ui = new UI(app, audio);
  let last = performance.now();
  // dynamic resolution: keep the frame time near 30 fps on slow GPUs, sharpen on fast ones
  let avg = 1 / 60, settle = 0;
  const maxScale = params.has('scale') ? app.scale : Math.min(window.devicePixelRatio || 1, 1.5);
  const loop = (now) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    app.frame(dt);
    audio.update(app);
    avg += (dt - avg) * 0.05;
    if (!params.has('scale') && (settle += dt) > 2.5 && !document.hidden) {
      const next = avg > 1 / 26 ? Math.max(app.scale * 0.88, 0.5) : avg < 1 / 50 ? Math.min(app.scale * 1.08, maxScale) : app.scale;
      if (Math.abs(next - app.scale) > 0.02) { app.scale = next; app.resize(); settle = 0; }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
