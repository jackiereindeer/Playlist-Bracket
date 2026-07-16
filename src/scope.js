/**
 * Subtle center-band scope. Dense high-frequency squiggle (like a real
 * time-domain analyser), not a slow multi-sine “heartbeat”.
 * Visual only — never touches <audio> playback.
 */

const BUF = 2048;
const wave = new Float32Array(BUF);
// Ring of recent noise samples for a continuous, non-looping hiss
const noiseRing = new Float32Array(BUF);
let noiseWrite = 0;

let canvas = null;
let c2d = null;
let rafId = 0;
let resizeObs = null;
let running = false;
let lastFrame = 0;

let phase = 0;
let energy = 0;
let targetEnergy = 0;
let rumble = 0;
let bright = 0;

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

/** Push fresh noise into the ring (scrolls left→right like live samples). */
function advanceNoise(count) {
  for (let i = 0; i < count; i++) {
    // White-ish noise with mild correlation so it isn’t pure static snow
    const white = Math.random() * 2 - 1;
    const prev = noiseRing[(noiseWrite - 1 + BUF) % BUF] || 0;
    noiseRing[noiseWrite % BUF] = prev * 0.35 + white * 0.65;
    noiseWrite = (noiseWrite + 1) % BUF;
  }
}

function readNoise(i) {
  return noiseRing[(noiseWrite + i) % BUF];
}

/**
 * Build a dense waveform: lots of zero-crossings across the width,
 * shaped by a slow envelope — reads as audio, not an ECG blip.
 */
function synthesize(playing, dt) {
  targetEnergy = playing ? 1 : 0;
  energy += (targetEnergy - energy) * Math.min(1, dt * 7);
  if (energy < 0.02) {
    wave.fill(0);
    return 0;
  }

  phase += dt * (18 + energy * 28);
  // How many new “samples” to scroll in this frame
  const scroll = Math.max(4, Math.floor(dt * 900 * (0.7 + energy)));
  advanceNoise(scroll);

  // Slow amplitude “music” motion
  rumble += dt * 2.4;
  bright += dt * 5.1;
  const envSlow =
    0.55 +
    0.25 * Math.sin(rumble) +
    0.2 * Math.sin(rumble * 0.37 + 1.1);

  let sumSq = 0;
  for (let i = 0; i < BUF; i++) {
    const t = i / (BUF - 1);
    const n0 = readNoise(i);
    const n1 = readNoise((i * 3 + 17) % BUF);
    const n2 = readNoise((i * 7 + 41) % BUF);

    // Dense carriers — many cycles across the screen (this kills the heartbeat look)
    const c1 = Math.sin(phase * 1.0 + t * Math.PI * 2 * 48);
    const c2 = Math.sin(phase * 1.7 + t * Math.PI * 2 * 73);
    const c3 = Math.sin(phase * 0.6 + t * Math.PI * 2 * 31);

    // Local envelope so amplitude jumps along the trace
    const localEnv =
      0.4 +
      0.6 * Math.abs(Math.sin(t * Math.PI * 6 + bright)) *
        (0.5 + 0.5 * Math.sin(t * Math.PI * 13 + phase * 0.2));

    let s =
      n0 * 0.72 +
      n1 * 0.28 +
      n2 * 0.12 +
      c1 * 0.18 +
      c2 * 0.1 +
      c3 * 0.08;

    s *= localEnv * envSlow * energy;
    // Soft clip like overloaded scope
    s = Math.tanh(s * 1.6);
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
  if (!playing && energy < 0.025 && tNow - lastFrame < 48) {
    rafId = requestAnimationFrame(drawFrame);
    return;
  }
  const dt = Math.min(0.05, Math.max(0.008, (tNow - lastFrame) / 1000 || 0.016));
  lastFrame = tNow;

  const w = canvas.width;
  const h = canvas.height;
  const midY = h * 0.5;
  const accent = cssAccent();

  c2d.clearRect(0, 0, w, h);

  const rms = synthesize(playing, dt);
  // Slim vertical band — detail comes from density, not height
  const band = h * 0.1;
  // Draw almost every sample so the line is fine and busy
  const step = Math.max(1, Math.floor(BUF / Math.min(BUF, w * 1.25)));

  if (energy > 0.025) {
    const amp = 0.75 + rms * 0.6;

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

    // Thin glow + thin core (not a fat hospital trace)
    stroke(0.16 + energy * 0.12, Math.max(1.5, (w / 1400) * 2.5), 10);
    stroke(0.5 + energy * 0.25, Math.max(0.9, (w / 1400) * 1.15), 2);

    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
  } else {
    c2d.beginPath();
    c2d.strokeStyle = accent;
    c2d.globalAlpha = 0.07;
    c2d.lineWidth = 1;
    c2d.moveTo(0, midY);
    c2d.lineTo(w, midY);
    c2d.stroke();
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
  energy = Math.max(energy, 0.55);
  advanceNoise(80);
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
