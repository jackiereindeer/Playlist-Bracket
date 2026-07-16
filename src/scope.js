/**
 * Full-viewport oscilloscope driven by the real preview audio stream
 * (Web Audio AnalyserNode time-domain data).
 */

const FFT_SIZE = 2048;
const sources = new WeakMap();

let audioCtx = null;
let analyser = null;
let masterGain = null;
let timeData = null;
let canvas = null;
let c2d = null;
let rafId = 0;
let resizeObs = null;
let running = false;
let lastFrame = 0;

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

function ensureGraph() {
  if (audioCtx) return audioCtx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;

  audioCtx = new AC();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = FFT_SIZE;
  analyser.smoothingTimeConstant = 0.35;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -10;

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1;

  // sources → master → analyser → speakers
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);

  timeData = new Uint8Array(analyser.fftSize);
  ensureCanvas();
  return audioCtx;
}

/**
 * Must be called before setting audio.src for CORS waveform data.
 */
export function prepareMediaElement(audio) {
  if (!audio) return;
  try {
    // Required so MediaElementSource can read samples from scdn.co previews
    if (!audio.crossOrigin) audio.crossOrigin = 'anonymous';
  } catch {
  }
}

/**
 * Route an <audio> element through the analyser graph (once per element).
 * After this, playback goes through Web Audio (element.volume still works).
 */
export function connectMediaElement(audio) {
  if (!audio) return false;
  prepareMediaElement(audio);
  const ctx = ensureGraph();
  if (!ctx || !masterGain) return false;

  try {
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
  }

  if (sources.has(audio)) return true;

  try {
    const src = ctx.createMediaElementSource(audio);
    src.connect(masterGain);
    sources.set(audio, src);
    return true;
  } catch {
    // Already connected elsewhere, or CORS / browser restriction
    return false;
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

function drawWavePath(data, w, midY, amp, step) {
  const n = data.length;
  c2d.beginPath();
  for (let i = 0; i < n; i += step) {
    const x = (i / (n - 1)) * w;
    const v = (data[i] - 128) / 128;
    const y = midY + v * midY * 0.72 * amp;
    if (i === 0) c2d.moveTo(x, y);
    else c2d.lineTo(x, y);
  }
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
  // Idle: ~20fps; playing: full display refresh
  if (!playing && tNow - lastFrame < 48) {
    rafId = requestAnimationFrame(drawFrame);
    return;
  }
  lastFrame = tNow;

  const w = canvas.width;
  const h = canvas.height;

  // Phosphor-style trail
  c2d.fillStyle = 'rgba(12, 11, 16, 0.22)';
  c2d.fillRect(0, 0, w, h);

  const accent = cssAccent();
  const midY = h * 0.5;

  let drewSignal = false;
  if (analyser && timeData && playing && audioCtx?.state === 'running') {
    analyser.getByteTimeDomainData(timeData);
    const n = timeData.length;

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const v = (timeData[i] - 128) / 128;
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / n);
    // Flat line (all ~128) means CORS blocked analyser — don't claim it's music
    drewSignal = peak > 0.02 || rms > 0.01;

    if (drewSignal) {
      const amp = Math.min(1.45, 0.5 + rms * 4.5);
      const step = Math.max(1, Math.floor(n / Math.min(n, w)));

      c2d.lineJoin = 'round';
      c2d.lineCap = 'round';
      c2d.strokeStyle = accent;
      c2d.shadowColor = accent;

      c2d.globalAlpha = 0.2 + rms * 0.4;
      c2d.lineWidth = Math.max(3, (w / 900) * 6);
      c2d.shadowBlur = 16 + rms * 36;
      drawWavePath(timeData, w, midY, amp, step);
      c2d.stroke();

      c2d.globalAlpha = 0.9;
      c2d.lineWidth = Math.max(1.2, (w / 900) * 2.1);
      c2d.shadowBlur = 5;
      drawWavePath(timeData, w, midY, amp, step);
      c2d.stroke();

      c2d.shadowBlur = 0;
      c2d.globalAlpha = 1;
    }
  }

  if (!drewSignal) {
    // Idle / no sample access — faint baseline (not fake music)
    c2d.beginPath();
    c2d.strokeStyle = accent;
    c2d.globalAlpha = playing ? 0.18 : 0.12;
    c2d.lineWidth = Math.max(1, w / 1200);
    c2d.shadowColor = accent;
    c2d.shadowBlur = 8;
    const t = tNow * 0.001;
    const pts = 120;
    for (let i = 0; i <= pts; i++) {
      const x = (i / pts) * w;
      const y = midY + Math.sin(i * 0.35 + t * 0.6) * (h * 0.008);
      if (i === 0) c2d.moveTo(x, y);
      else c2d.lineTo(x, y);
    }
    c2d.stroke();
    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
  }

  rafId = requestAnimationFrame(drawFrame);
}

export function startScope() {
  ensureCanvas();
  ensureGraph();
  try {
    audioCtx?.resume?.().catch(() => {});
  } catch {
  }
  if (running) return;
  running = true;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(drawFrame);
}

export function kickScopeFromPlayback() {
  startScope();
  try {
    audioCtx?.resume?.().catch(() => {});
  } catch {
  }
}

export function stopScopeLoop() {
  running = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
}

/** Soft-clear the canvas (e.g. after dispose). Does not close AudioContext. */
export function clearScopeFrame() {
  if (!c2d || !canvas) return;
  c2d.clearRect(0, 0, canvas.width, canvas.height);
}

/**
 * On full media teardown we don't close AudioContext (expensive / user-gesture).
 * WeakMap drops sources when audio elements are GC'd after innerHTML swaps.
 */
export function onMediaDisposed() {
  // If nothing is playing, leave a quiet baseline; loop can keep idling cheaply
  if (!anyMediaPlaying()) {
    // keep scope running for idle line if already on
  }
}

// Resume drawing when tab is visible again
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startScope();
    } else {
      stopScopeLoop();
    }
  });
}
