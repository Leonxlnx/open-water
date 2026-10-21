// Minimal interface: weather presets, sound, and a tuning sheet. Auto-hides when idle.
import { PRESETS } from './weather.js';

const SLIDERS = [
  { key: 'wind', label: 'Wind', min: 0.5, max: 26, step: 0.1, fmt: (v) => `${v.toFixed(1)} m/s · Bf ${beaufort(v)}` },
  { key: 'waveScale', label: 'Waves', min: 0.2, max: 1.8, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'choppy', label: 'Chop', min: 0, max: 1.4, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: 'rain', label: 'Rain', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 50)} mm/h` },
  { key: 'clouds', label: 'Clouds', min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: 'lightning', label: 'Lightning', min: 0, max: 1, step: 0.01, fmt: (v) => (v < 0.01 ? 'off' : `${Math.round(v * 100)}%`) },
  { key: 'sunElev', label: 'Sun height', min: -3, max: 75, step: 0.1, fmt: (v) => `${v.toFixed(1)}°` },
  { key: 'sunAz', label: 'Sun bearing', min: 0, max: 360, step: 1, fmt: (v) => `${Math.round(v)}°` },
];

// Beaufort force from 10 m wind speed (WMO upper limits, m/s)
const beaufort = (v) => {
  const i = [0.5, 1.5, 3.3, 5.5, 7.9, 10.7, 13.8, 17.1, 20.7, 24.4, 28.4, 32.6].findIndex((x) => v < x);
  return i < 0 ? 12 : i;
};

const ICON = {
  sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z"/><path class="wave" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/><path class="mute" d="M16 9.5l5 5M21 9.5l-5 5"/></svg>',
  tune: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z"/></svg>',
};

export class UI {
  constructor(app, audio) {
    this.app = app;
    this.audio = audio;
    this.root = document.createElement('div');
    this.root.className = 'ui';
    this.root.innerHTML = `
      <div class="mark">Open Water</div>
      <div class="hint">Drag to look · Scroll to rise or sink</div>
      <div class="dock">
        <nav class="presets pill" role="tablist">
          ${Object.keys(PRESETS).map((k) => `<button role="tab" data-preset="${k}">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
        </nav>
        <div class="tools pill">
          <button class="icon strike" title="Lightning strike (L)" aria-label="Lightning strike">${ICON.bolt}</button>
          <button class="icon sound muted" title="Sound (M)" aria-label="Sound">${ICON.sound}</button>
          <button class="icon tune" title="Tune (T)" aria-label="Tune">${ICON.tune}</button>
        </div>
      </div>
      <section class="sheet" aria-label="Tune">
        ${SLIDERS.map((s) => `
          <label class="row">
            <span class="name">${s.label}</span><output data-out="${s.key}"></output>
            <input type="range" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}">
          </label>`).join('')}
      </section>`;
    document.body.appendChild(this.root);
    this.bind();
    this.sync();
    this.idle();
    // live significant wave height next to the wave slider
    setInterval(() => {
      const hs = this.app.stats && this.app.stats.hs;
      const o = this.root.querySelector('[data-out="waveScale"]');
      if (hs && o) o.textContent = `Hs ${hs.toFixed(1)} m`;
    }, 500);
  }

  bind() {
    const W = this.app.weather;
    this.root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      W.setPreset(b.dataset.preset);
      this.sync();
    }));
    this.root.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => {
      W.set(inp.dataset.key, Number(inp.value));
      this.root.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('on'));
      this.out(inp.dataset.key, Number(inp.value));
    }));
    const tune = this.root.querySelector('.tune');
    tune.addEventListener('click', () => this.root.classList.toggle('open'));
    this.root.querySelector('.sound').addEventListener('click', () => this.toggleSound());
    this.root.querySelector('.strike').addEventListener('click', () => this.app.lightning.trigger(this.app.cam, { base: W.state.cloudBase }));
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      if (k === 'h') this.root.classList.toggle('hidden');
      if (k === 't') this.root.classList.toggle('open');
      if (k === 'm') this.toggleSound();
      if (k === 'l') this.app.lightning.trigger(this.app.cam, { base: W.state.cloudBase });
      if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
      const idx = ['1', '2', '3', '4'].indexOf(k);
      if (idx >= 0) { W.setPreset(Object.keys(PRESETS)[idx]); this.sync(); }
    });
  }

  async toggleSound() {
    const btn = this.root.querySelector('.sound');
    const on = btn.classList.contains('muted');
    btn.classList.toggle('muted', !on);
    await this.audio.enable(on);
  }

  out(key, v) {
    const s = SLIDERS.find((x) => x.key === key);
    this.root.querySelector(`[data-out="${key}"]`).textContent = s.fmt(v);
  }

  sync() {
    const W = this.app.weather;
    const all = { ...W.target, ...W.timeTarget };
    for (const s of SLIDERS) {
      const inp = this.root.querySelector(`input[data-key="${s.key}"]`);
      inp.value = all[s.key];
      this.out(s.key, all[s.key]);
    }
    this.root.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === W.preset));
  }

  idle() {
    let timer;
    const wake = () => {
      this.root.classList.remove('asleep');
      clearTimeout(timer);
      timer = setTimeout(() => { if (!this.root.matches(':hover') && !this.root.classList.contains('open')) this.root.classList.add('asleep'); }, 3200);
    };
    ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((e) => window.addEventListener(e, wake, { passive: true }));
    wake();
    setTimeout(() => this.root.querySelector('.hint').classList.add('gone'), 6000);
  }
}

export const UI_CSS = `
.ui { --glass: rgba(14, 18, 24, 0.34); --line: rgba(255, 255, 255, 0.09); --ink: rgba(255, 255, 255, 0.9); --mute: rgba(255, 255, 255, 0.5);
  position: fixed; inset: 0; pointer-events: none; color: var(--ink);
  font: 500 12px/1 ui-sans-serif, -apple-system, "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; letter-spacing: 0.02em;
  transition: opacity 0.6s ease; -webkit-font-smoothing: antialiased; }
.ui.asleep .dock, .ui.asleep .mark, .ui.hidden > * { opacity: 0; }
.ui.hidden > * { pointer-events: none !important; }
.ui button { all: unset; cursor: pointer; }
.mark { position: absolute; top: 22px; left: 24px; font-size: 11px; letter-spacing: 0.32em; text-transform: uppercase; color: var(--mute); transition: opacity 0.8s ease; }
.hint { position: absolute; left: 50%; bottom: 84px; transform: translateX(-50%); color: var(--mute); font-size: 11px; letter-spacing: 0.08em; transition: opacity 1.2s ease; white-space: nowrap; }
.hint.gone { opacity: 0; }
.dock { position: absolute; left: 50%; bottom: 22px; transform: translateX(-50%); display: flex; gap: 8px; pointer-events: auto; transition: opacity 0.6s ease; }
.pill { display: flex; align-items: center; gap: 2px; padding: 4px; border-radius: 999px; background: var(--glass); border: 1px solid var(--line);
  -webkit-backdrop-filter: blur(16px) saturate(150%); backdrop-filter: blur(16px) saturate(150%); }
.presets button { padding: 9px 15px; border-radius: 999px; color: var(--mute); transition: color 0.25s, background 0.25s; }
.presets button:hover { color: var(--ink); }
.presets button.on { color: #0b0e12; background: rgba(255, 255, 255, 0.88); }
.icon { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 999px; color: var(--mute); transition: color 0.25s, background 0.25s; }
.icon:hover { color: var(--ink); background: rgba(255, 255, 255, 0.06); }
.icon svg { width: 17px; height: 17px; }
.sound .mute { display: none; }
.sound.muted .mute { display: inline; }
.sound.muted .wave { display: none; }
.ui.open .tune { color: #0b0e12; background: rgba(255, 255, 255, 0.88); }
.sheet { position: absolute; right: 50%; bottom: 74px; transform: translate(calc(50% + 0px), 8px); width: min(340px, calc(100vw - 32px));
  padding: 14px 18px 8px; border-radius: 18px; background: var(--glass); border: 1px solid var(--line);
  -webkit-backdrop-filter: blur(18px) saturate(150%); backdrop-filter: blur(18px) saturate(150%);
  opacity: 0; pointer-events: none; transition: opacity 0.3s ease, transform 0.3s ease; }
.ui.open .sheet { opacity: 1; transform: translate(50%, 0); pointer-events: auto; }
.row { display: grid; grid-template-columns: 1fr auto; align-items: center; row-gap: 2px; padding: 6px 0; }
.row .name { color: var(--mute); }
.row output { font-variant-numeric: tabular-nums; color: var(--ink); }
.row input { grid-column: 1 / -1; -webkit-appearance: none; appearance: none; width: 100%; height: 18px; background: transparent; margin: 0; cursor: pointer; }
.row input::-webkit-slider-runnable-track { height: 1px; background: rgba(255, 255, 255, 0.22); }
.row input::-moz-range-track { height: 1px; background: rgba(255, 255, 255, 0.22); }
.row input::-webkit-slider-thumb { -webkit-appearance: none; width: 11px; height: 11px; margin-top: -5px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 4px rgba(255,255,255,0.08); }
.row input::-moz-range-thumb { width: 11px; height: 11px; border: 0; border-radius: 50%; background: #fff; }
@media (max-width: 560px) {
  .dock { bottom: 16px; flex-direction: column; align-items: center; }
  .presets button { padding: 9px 11px; }
  .mark { top: 16px; left: 16px; }
  .sheet { bottom: 116px; }
  .hint { bottom: 126px; }
}
`;
