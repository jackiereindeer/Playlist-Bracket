/**
 * Full-viewport oscilloscope backdrop.
 * Visual only — does NOT touch <audio> elements (createMediaElementSource
 * was muting all previews). When music is playing, draws a lively reactive
 * wave; otherwise a faint idle baseline.
 */

let canvas = null;
let c2d = null;
let rafId = 0;
let resizeObs = null;
let running = false;
let lastFrame = 0;
let pulse = 0;

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
  if (!playing && tNow - lastFrame < 48) {
    rafId = requestAnimationFrame(drawFrame);
    return;
  }
  lastFrame = tNow;

  const w = canvas.width;
  const h = canvas.height;
  const midY = h * 0.5;
  const accent = cssAccent();
  const t = tNow * 0.001;

  c2d.fillStyle = 'rgba(12, 11, 16, 0.22)';
  c2d.fillRect(0, 0, w, h);

  // Ease pulse up/down with play state
  pulse += ((playing ? 1 : 0) - pulse) * 0.08;
  const amp = playing ? 0.12 + pulse * 0.28 : 0.012;
  const pts = playing ? 180 : 100;

  c2d.beginPath();
  c2d.strokeStyle = accent;
  c2d.globalAlpha = playing ? 0.35 + pulse * 0.35 : 0.12;
  c2d.lineWidth = Math.max(1.2, (w / 900) * (playing ? 2.4 : 1.2));
  c2d.lineJoin = 'round';
  c2d.lineCap = 'round';
  c2d.shadowColor = accent;
  c2d.shadowBlur = playing ? 14 + pulse * 20 : 8;

  for (let i = 0; i <= pts; i++) {
    const x = (i / pts) * w;
    const n = i / pts;
    // Layered sines → scope-like motion while music plays (visual only)
    const y =
      midY +
      Math.sin(n * Math.PI * 6 + t * 4.2) * h * amp * 0.55 +
      Math.sin(n * Math.PI * 14 + t * 7.1) * h * amp * 0.28 +
      Math.sin(n * Math.PI * 2.2 + t * 1.7) * h * amp * 0.35;
    if (i === 0) c2d.moveTo(x, y);
    else c2d.lineTo(x, y);
  }
  c2d.stroke();

  if (playing) {
    c2d.beginPath();
    c2d.globalAlpha = 0.75;
    c2d.lineWidth = Math.max(1, (w / 900) * 1.4);
    c2d.shadowBlur = 4;
    for (let i = 0; i <= pts; i++) {
      const x = (i / pts) * w;
      const n = i / pts;
      const y =
        midY +
        Math.sin(n * Math.PI * 6 + t * 4.2) * h * amp * 0.55 +
        Math.sin(n * Math.PI * 14 + t * 7.1) * h * amp * 0.28 +
        Math.sin(n * Math.PI * 2.2 + t * 1.7) * h * amp * 0.35;
      if (i === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    }
    c2d.stroke();
  }

  c2d.shadowBlur = 0;
  c2d.globalAlpha = 1;
  rafId = requestAnimationFrame(drawFrame);
}

/** Kept for API compatibility — does not touch audio elements. */
export function prepareMediaElement(_audio) {}

/** Kept for API compatibility — never routes audio (that muted previews). */
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
