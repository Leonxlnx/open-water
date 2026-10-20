// Sound: procedural sea wash, whitecap hiss, gusting wind and rain fizz, plus recorded rain and
// thunder. Every modulation is a deterministic function of time, so the same engine renders the
// live mix (AudioContext) and the offline soundtrack of the film (OfflineAudioContext).

const THUNDER_FILES = ['thunder_a', 'thunder_b', 'thunder_c', 'thunder_d', 'thunder_e', 'thunder_f'];
const BASE = new URL('../../assets/audio/', import.meta.url);

function hash(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
function vnoise(t) { const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f); return hash(i) * (1 - u) + hash(i + 1) * u; }
function fbm(t) { return (vnoise(t) * 0.55 + vnoise(t * 2.13 + 7) * 0.3 + vnoise(t * 4.71 + 13) * 0.15); }
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

function noiseBuffer(ctx, seconds, color, seed = 1) {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let s = (seed + ch * 101) >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd();
      if (color === 'pink') { // Paul Kellet
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else if (color === 'brown') {
        br = (br + 0.02 * w) / 1.02; d[i] = br * 3.5;
      } else d[i] = w * 0.5;
    }
    // crossfade ends for a seamless loop
    const f = Math.floor(ctx.sampleRate * 0.25);
    for (let i = 0; i < f; i++) { const a = i / f; d[i] = d[i] * a + d[n - f + i] * (1 - a); }
  }
  return buf;
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = {};
    this.params = { wind: 8, rain: 0, foam: 0.01, hs: 2, tp: 8, flash: 0 };
    this.volume = 0.9;
  }

  async loadBuffers(ctx) {
    const names = ['rain_heavy', ...THUNDER_FILES, 'thunder_close'];
    await Promise.all(names.map(async (n) => {
      try {
        const res = await fetch(new URL(`${n}.mp3`, BASE));
        this.buffers[n] = await ctx.decodeAudioData(await res.arrayBuffer());
      } catch (e) { console.warn('audio', n, e); }
    }));
  }

  // Build the graph on a context (live or offline).
  async init(ctx) {
    this.ctx = ctx;
    await this.loadBuffers(ctx);
    const out = ctx.createDynamicsCompressor();
    out.threshold.value = -14; out.knee.value = 12; out.ratio.value = 3; out.attack.value = 0.01; out.release.value = 0.4;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(out).connect(ctx.destination);
    this.bus = ctx.createGain();
    this.bus.connect(this.master);

    const loop = (buffer, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buffer; s.loop = true; s.playbackRate.value = rate; s.start(0); return s; };
    const brown = noiseBuffer(ctx, 9.3, 'brown', 3), pink = noiseBuffer(ctx, 7.1, 'pink', 5), white = noiseBuffer(ctx, 5.3, 'white', 9);
    const chain = (src, ...nodes) => { let n = src; for (const x of nodes) { n.connect(x); n = x; } n.connect(this.bus); return nodes[nodes.length - 1]; };
    const filt = (type, f, q = 0.7) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; };
    const gain = (g = 0) => { const n = ctx.createGain(); n.gain.value = g; return n; };

    // sea: low wash of passing swells (brown noise) + whitecap hiss (pink, band-passed)
    this.washLP = filt('lowpass', 420, 0.5);
    this.wash = chain(loop(brown), this.washLP, gain());
    this.hissBP = filt('bandpass', 2400, 0.45);
    this.hiss = chain(loop(pink, 0.97), filt('highpass', 900), this.hissBP, gain());
    // wind: broadband rush + a narrow whistle that rises with gusts
    this.windBP = filt('bandpass', 520, 0.6);
    this.wind = chain(loop(pink, 1.03), this.windBP, gain());
    this.whistleBP = filt('bandpass', 1900, 9);
    this.whistle = chain(loop(white, 1.0), this.whistleBP, gain());
    // rain: recorded downpour bed + fizz of drops on water
    if (this.buffers.rain_heavy) {
      this.rainLP = filt('lowpass', 3000, 0.5);
      this.rainBed = chain(loop(this.buffers.rain_heavy), this.rainLP, gain());
    }
    this.fizz = chain(loop(white, 0.93), filt('highpass', 4200), filt('lowpass', 13000), gain());
    this.scheduledUntil = 0;
    this.thunderQueue = [];
  }

  set(p) { Object.assign(this.params, p); }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1);
  }

  // Deterministic modulation at time t (seconds) for the current parameters.
  levels(t, p) {
    const U = p.wind;
    const windN = clamp((U - 2) / 23, 0, 1);
    const gust = 0.65 + 0.7 * fbm(t * 0.23 + 3) * (0.4 + windN);
    // swell envelopes at the dominant period with irregular groups
    const tp = Math.max(p.tp, 3);
    const swell = 0.55 + 0.45 * Math.pow(0.5 + 0.5 * Math.sin((2 * Math.PI * t) / tp + 3 * vnoise(t / (tp * 3))), 2);
    const group = 0.6 + 0.6 * vnoise(t / (tp * 4) + 11);
    return {
      wash: (0.05 + 0.1 * clamp(p.hs / 8, 0, 1.2)) * swell * group,
      washF: 260 + 900 * windN * swell,
      hiss: (0.004 + 0.9 * Math.sqrt(clamp(p.foam, 0, 0.4))) * 0.22 * (0.4 + 0.9 * swell * vnoise(t * 0.9 + 5)),
      hissF: 1800 + 2600 * windN,
      wind: (0.008 + 0.32 * Math.pow(windN, 1.7)) * gust,
      windF: 320 + 700 * windN * gust,
      whistle: 0.05 * Math.pow(windN, 2.4) * Math.pow(clamp(gust - 0.6, 0, 1), 2),
      whistleF: 1300 + 1500 * gust * windN,
      rain: 0.62 * Math.pow(clamp(p.rain, 0, 1), 0.7),
      rainF: 1800 + 9000 * clamp(p.rain, 0, 1),
      fizz: 0.035 * Math.pow(clamp(p.rain, 0, 1), 0.8),
    };
  }

  apply(t, p, k = 0.12) {
    const L = this.levels(t, p);
    const set = (param, v) => param.setTargetAtTime(v, t, k);
    set(this.wash.gain, L.wash); set(this.washLP.frequency, L.washF);
    set(this.hiss.gain, L.hiss); set(this.hissBP.frequency, L.hissF);
    set(this.wind.gain, L.wind); set(this.windBP.frequency, L.windF);
    set(this.whistle.gain, L.whistle); set(this.whistleBP.frequency, L.whistleF);
    if (this.rainBed) { set(this.rainBed.gain, L.rain); set(this.rainLP.frequency, L.rainF); }
    set(this.fizz.gain, L.fizz);
  }

  // Live: called every frame; schedules a short window ahead.
  tick() {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now + 0.05 < this.scheduledUntil) return;
    this.apply(now + 0.05, this.params);
    this.scheduledUntil = now + 0.1;
  }

  // Thunder from a strike at distance (m): delay by the speed of sound, air absorption removes
  // highs with distance (the crack becomes a rumble), level falls ~1/r with a floor.
  thunder(at, dist, power = 1, seed = Math.random()) {
    const ctx = this.ctx;
    if (!ctx) return;
    const close = dist < 2200 && this.buffers.thunder_close;
    const name = close ? 'thunder_close' : THUNDER_FILES[Math.floor(seed * THUNDER_FILES.length) % THUNDER_FILES.length];
    const buf = this.buffers[name];
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = 0.92 + seed * 0.16 - Math.min(dist / 40000, 0.12);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = clamp(14000 / (1 + dist / 1200), 250, 14000);
    const g = ctx.createGain();
    g.gain.value = clamp(power * 1.6 / (1 + dist / 2500), 0.05, 1.4);
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    let n = src.connect(lp).connect(g);
    if (pan) { pan.pan.value = (seed - 0.5) * 0.9; n = n.connect(pan); }
    n.connect(this.bus);
    src.start(at + dist / 343);
  }
}

// Offline soundtrack: params(t) gives the weather timeline, strikes = [{t, dist, power}].
export async function renderSoundtrack(duration, paramsAt, strikes, sampleRate = 48000) {
  const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  const eng = new AudioEngine();
  await eng.init(ctx);
  for (let t = 0; t < duration; t += 0.05) eng.apply(t, paramsAt(t), 0.08);
  strikes.forEach((s, i) => eng.thunder(s.t, s.dist, s.power, (i * 0.618 + 0.13) % 1));
  return ctx.startRendering();
}

export function encodeWav(buffer) {
  const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  w(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { out.setInt16(o, clamp(data[c][i], -1, 1) * 32767, true); o += 2; }
  return out.buffer;
}
