/**
 * Subtle center-band oscilloscope backdrop.
 * Plain visual layer only — never routes <audio> (keeps previews working).
 */

const BUF = 1024;
const wave = new Float32Array(BUF);

let canvas = null;
let c2d = null;
let rafId = 0;
let resizeObs = null;
let running = false;
let lastFrame = 0;

let phase = 0;
let energy = 0;
let targetEnergy = 0;
// A few drifting partials — enough motion without static noise
const partials = [
  { f: 2.1, p: 0, a: 1.0 },
  { f: 3.4, p: 1.2, a: 0.55 },
  { f: 5.8, p: 0.4, a: 0.32 },
  { f: 8.3, p: 2.1, a: 0.18 },
  { f: 12.6, p: 0.9, a: 0.1 },
];

function cssAccent() {
  try {
    const raw = getComputedStyle(document.body).getPropertyValue('--accent').trim();
    return raw || '#1ed760';
  } catch {
    return '#1ed760';
  }
}

function ensureCanvas() {
  if (canvas && canvas.isConnected) return canvas;
  canvas = document.getElementById('scope-bg');
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = 'scope-bg';
    canvas.setAttribute('aria-hidden', 'true');
    document.body.prepend(canvas);
  }
  c2d = canvas.getContext('2d', { alpha: true });
  sizeCanvas();
  if (!resizeObs) {
    resizeObs = new ResizeObserver(() => sizeCanvas());
    resizeObs.observe(document.documentElement);
    window.addEventListener('resize', sizeCanvas, { passive: true });
  }
  return canvas;
}

function sizeCanvas() {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  const pw = Math.floor(w * dpr);
  const ph = Math.floor(h * dpr);
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw;
    canvas.height = ph;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
}

function anyMediaPlaying() {
  for (const id of [
    'audio-a',
    'audio-b',
    'audio-champion',
    'audio-transition',
    'audio-champion-bed',
  ]) {
    const el = document.getElementById(id);
    if (el && !el.paused && !el.ended) return true;
  }
  return false;
}

function synthesize(playing, dt) {
  targetEnergy = playing ? 1 : 0;
  energy += (targetEnergy - energy) * Math.min(1, dt * 5);
  if (energy < 0.015) {
    wave.fill(0);
    return 0;
  }

  phase += dt * (2.8 + energy * 3.5);

  // Gentle frequency drift
  for (let i = 0; i < partials.length; i++) {
    const pr = partials[i];
    pr.f += Math.sin(phase * 0.15 + i * 1.7) * dt * 0.15;
    pr.f = Math.min(16, Math.max(1.2, pr.f));
    pr.p += pr.f * dt * Math.PI * 2 * 0.85;
  }

  let sumSq = 0;
  for (let i = 0; i < BUF; i++) {
    const t = i / (BUF - 1);
    let s = 0;
    for (const pr of partials) {
      s += Math.sin(pr.p + t * Math.PI * 2 * pr.f) * pr.a;
    }
    // Light high-frequency shimmer (not hash static)
    s += Math.sin(t * Math.PI * 40 + phase * 9) * 0.08 * energy;
    s += Math.sin(t * Math.PI * 23 + phase * 5.5) * 0.06 * energy;
    // Soft amplitude breathing so it isn't a flat ribbon
    const env = 0.75 + 0.25 * Math.sin(t * Math.PI * 2 + phase * 0.6);
    s = Math.tanh(s * 0.55) * env * energy;
    wave[i] = s;
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / BUF);
}

function drawFrame(now) {
  rafId = 0;
  if (!running || !c2d || !canvas) {
    running = false;
    return;
  }
  if (document.visibilityState === 'hidden') {
    running = false;
    return;
  }

  const tNow = now || performance.now();
  const playing = anyMediaPlaying();
  if (!playing && energy < 0.02 && tNow - lastFrame < 50) {
    rafId = requestAnimationFrame(drawFrame);
    return;
  }
  const dt = Math.min(0.05, Math.max(0.008, (tNow - lastFrame) / 1000 || 0.016));
  lastFrame = tNow;

  const w = canvas.width;
  const h = canvas.height;
  const midY = h * 0.5;
  const accent = cssAccent();

  // Fade trail — mostly transparent so UI stays readable
  c2d.clearRect(0, 0, w, h);

  const rms = synthesize(playing, dt);
  // Keep the wave in a slim center band (~12% of viewport height)
  const band = h * 0.12;
  const step = Math.max(1, Math.floor(BUF / Math.min(BUF, w)));

  if (energy > 0.02) {
    const amp = 0.55 + rms * 0.9;

    c2d.lineJoin = 'round';
    c2d.lineCap = 'round';
    c2d.strokeStyle = accent;
    c2d.shadowColor = accent;

    const stroke = (alpha, width, blur) => {
      c2d.beginPath();
      c2d.globalAlpha = alpha;
      c2d.lineWidth = width;
      c2d.shadowBlur = blur;
      for (let i = 0; i < BUF; i += step) {
        const x = (i / (BUF - 1)) * w;
        const y = midY + wave[i] * band * amp;
        if (i === 0) c2d.moveTo(x, y);
        else c2d.lineTo(x, y);
      }
      c2d.stroke();
    };

    stroke(0.14 + energy * 0.1, Math.max(2, (w / 1100) * 3.5), 12);
    stroke(0.4 + energy * 0.2, Math.max(1, (w / 1100) * 1.5), 3);

    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
  } else {
    // Faint idle hairline
    c2d.beginPath();
    c2d.strokeStyle = accent;
    c2d.globalAlpha = 0.08;
    c2d.lineWidth = Math.max(1, w / 1400);
    c2d.shadowColor = accent;
    c2d.shadowBlur = 4;
    const t = tNow * 0.001;
    const pts = 80;
    for (let i = 0; i <= pts; i++) {
      const x = (i / pts) * w;
      const y = midY + Math.sin(i * 0.4 + t * 0.5) * (h * 0.004);
      if (i === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    }
    c2d.stroke();
    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
  }

  rafId = requestAnimationFrame(drawFrame);
}

export function prepareMediaElement(_audio) {}
export function connectMediaElement(_audio) {
  return false;
}

export function startScope() {
  ensureCanvas();
  if (running) return;
  running = true;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(drawFrame);
}

export function kickScopeFromPlayback() {
  startScope();
  targetEnergy = 1;
  energy = Math.max(energy, 0.4);
}

export function stopScopeLoop() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

export function clearScopeFrame() {
  if (!c2d || !canvas) return;
  c2d.clearRect(0, 0, canvas.width, canvas.height);
}

export function onMediaDisposed() {}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startScope();
    else stopScopeLoop();
  });
}
