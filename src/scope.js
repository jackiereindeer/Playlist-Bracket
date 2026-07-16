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
/** Smoothed 0–1 from the loudest playing preview’s volume slider. */
let volumeLevel = 0;
let rumble = 0;
let bright = 0;

const AUDIO_IDS = [
  'audio-a',
  'audio-b',
  'audio-champion',
  'audio-transition',
  'audio-champion-bed',
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
  for (const id of AUDIO_IDS) {
    const el = document.getElementById(id);
    if (el && !el.paused && !el.ended) return true;
  }
  return false;
}

/**
 * Volume of the currently playing preview (0–1).
 * Uses the <audio>.volume that the sliders write to in real time.
 * If several play (shouldn't), takes the loudest.
 */
function getPlaybackVolume() {
  let maxVol = 0;
  let anyPlaying = false;

  for (const id of AUDIO_IDS) {
    const el = document.getElementById(id);
    if (!el || el.paused || el.ended) continue;
    anyPlaying = true;
    const v = typeof el.volume === 'number' && Number.isFinite(el.volume) ? el.volume : 0;
    if (v > maxVol) maxVol = v;
  }

  if (!anyPlaying) return 0;
  return Math.min(1, Math.max(0, maxVol));
}

/**
 * Map linear slider 0–1 → a punchier visual gain.
 * Quiet = almost flat; loud = big / busy scope.
 */
function visualGainFromVolume(vol01) {
  // Dead zone near silence, then strong curve
  if (vol01 <= 0.02) return 0;
  // Ease-in power curve so mid→high is dramatic
  const t = (vol01 - 0.02) / 0.98;
  return Math.pow(t, 1.35);
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
 * Dense waveform driven by play state + user volume gain (0–1).
 */
function synthesize(playing, volGain, dt) {
  targetEnergy = playing && volGain > 0.01 ? volGain : 0;
  // Track volume quickly so slider drags feel instant
  energy += (targetEnergy - energy) * Math.min(1, dt * (playing ? 14 : 7));
  volumeLevel += (volGain - volumeLevel) * Math.min(1, dt * 18);

  if (energy < 0.015) {
    wave.fill(0);
    return 0;
  }

  const g = energy;
  phase += dt * (12 + g * 40);
  const scroll = Math.max(2, Math.floor(dt * (200 + g * 1400)));
  advanceNoise(scroll);

  rumble += dt * (1.2 + g * 3.2);
  bright += dt * (2.5 + g * 6);
  const envSlow =
    0.5 +
    0.28 * Math.sin(rumble) +
    0.22 * Math.sin(rumble * 0.37 + 1.1);

  let sumSq = 0;
  const dens = 28 + g * 55;
  for (let i = 0; i < BUF; i++) {
    const t = i / (BUF - 1);
    const n0 = readNoise(i);
    const n1 = readNoise((i * 3 + 17) % BUF);
    const n2 = readNoise((i * 7 + 41) % BUF);

    const c1 = Math.sin(phase * 1.0 + t * Math.PI * 2 * dens);
    const c2 = Math.sin(phase * 1.7 + t * Math.PI * 2 * dens * 1.52);
    const c3 = Math.sin(phase * 0.6 + t * Math.PI * 2 * dens * 0.65);

    const localEnv =
      0.35 +
      0.65 * Math.abs(Math.sin(t * Math.PI * 6 + bright)) *
        (0.5 + 0.5 * Math.sin(t * Math.PI * 13 + phase * 0.2));

    const noiseW = 0.25 + g * 0.75;
    let s =
      n0 * 0.72 * noiseW +
      n1 * 0.28 * noiseW +
      n2 * 0.12 * noiseW +
      c1 * 0.16 +
      c2 * 0.1 +
      c3 * 0.08;

    s *= localEnv * envSlow * g;
    s = Math.tanh(s * (1.1 + g * 1.2));
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
  const rawVol = playing ? getPlaybackVolume() : 0;
  const volGain = playing ? visualGainFromVolume(rawVol) : 0;

  if (!playing && energy < 0.02 && tNow - lastFrame < 48) {
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

  const rms = synthesize(playing, volGain, dt);
  // Band height scales hard with volume: whisper → hairline, max → ~22% of screen
  const band = h * (0.02 + volumeLevel * 0.2);
  const step = Math.max(1, Math.floor(BUF / Math.min(BUF, w * 1.25)));

  if (energy > 0.015) {
    const amp = 0.55 + rms * 0.9 + volumeLevel * 0.45;

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

    // Opacity / glow / thickness all follow the slider
    const g = volumeLevel;
    stroke(
      0.06 + g * 0.28,
      Math.max(1, (w / 1400) * (1.2 + g * 3.2)),
      4 + g * 22
    );
    stroke(
      0.2 + g * 0.65,
      Math.max(0.8, (w / 1400) * (0.8 + g * 1.6)),
      1 + g * 6
    );

    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
  } else {
    c2d.beginPath();
    c2d.strokeStyle = accent;
    c2d.globalAlpha = 0.06;
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
  const g = visualGainFromVolume(getPlaybackVolume() || 0.35);
  targetEnergy = g;
  energy = Math.max(energy, g * 0.85);
  volumeLevel = Math.max(volumeLevel, g);
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
