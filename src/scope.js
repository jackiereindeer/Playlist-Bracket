/**
 * Full-viewport oscilloscope backdrop.
 * Looks like a live time-domain scope (jumpy / phosphor) without routing
 * <audio> through Web Audio (that was muting previews).
 *
 * When something is playing we synthesize a chaotic waveform that behaves
 * like analyser time-domain data; idle is a faint flat line.
 */

const BUF = 2048;
const wave = new Float32Array(BUF);

let canvas = null;
let c2d = null;
let rafId = 0;
let resizeObs = null;
let running = false;
let lastFrame = 0;

// Synthesis state (kept across frames so the wave is continuous, not a new shape every paint)
let phase = 0;
let noiseSeed = 1;
let energy = 0;
let targetEnergy = 0;
let spikeTimer = 0;
let harmPhases = [0, 0, 0, 0, 0, 0, 0, 0];
let harmFreqs = [1.0, 2.3, 3.7, 5.1, 7.4, 11.2, 13.9, 17.6];
let harmAmps = [1, 0.55, 0.35, 0.28, 0.18, 0.12, 0.08, 0.05];

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

/** Fast deterministic-ish noise 0..1 */
function hashNoise(n) {
  const x = Math.sin(n * 127.1 + noiseSeed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Fill `wave` with a jumpy time-domain-like signal for this frame.
 * Continuous phases keep it from looking like a looping heart-monitor blip.
 */
function synthesizeWave(playing, dt) {
  targetEnergy = playing ? 1 : 0;
  energy += (targetEnergy - energy) * Math.min(1, dt * 6);

  if (energy < 0.02) {
    for (let i = 0; i < BUF; i++) wave[i] = 0;
    return 0;
  }

  // Slowly drift partial frequencies so the shape never settles
  for (let h = 0; h < harmFreqs.length; h++) {
    harmFreqs[h] += (hashNoise(phase * 0.01 + h * 17) - 0.5) * dt * 0.8;
    harmFreqs[h] = Math.min(24, Math.max(0.4, harmFreqs[h]));
    harmPhases[h] += harmFreqs[h] * dt * (9 + h * 1.4);
  }

  phase += dt * (14 + energy * 22);
  noiseSeed += dt * 3.1;

  // Occasional transient spikes (like drums / attacks)
  spikeTimer -= dt;
  let spike = 0;
  if (spikeTimer <= 0) {
    spikeTimer = 0.08 + hashNoise(phase) * 0.45;
    spike = (hashNoise(phase + 9) - 0.5) * 2.2 * energy;
  }

  let sumSq = 0;
  const n = BUF;
  for (let i = 0; i < n; i++) {
    const t = i / n;

    // Stack of detuned partials (music-ish, not a single sine)
    let s = 0;
    for (let h = 0; h < harmPhases.length; h++) {
      s += Math.sin(harmPhases[h] + t * Math.PI * 2 * harmFreqs[h]) * harmAmps[h];
    }

    // High-frequency hash noise for that jumpy analyser look
    const n1 = hashNoise(i * 0.37 + phase * 40) * 2 - 1;
    const n2 = hashNoise(i * 1.91 + phase * 73) * 2 - 1;
    const n3 = hashNoise(i * 4.2 + phase * 11) * 2 - 1;

    // Envelope variation across the buffer (not a flat hospital pulse)
    const env =
      0.55 +
      0.45 * Math.sin(t * Math.PI * 2 * 3 + phase * 0.7) *
        Math.sin(t * Math.PI * 5 + phase * 1.3);

    // Soft clip mix
    let sample =
      s * 0.22 * env +
      n1 * 0.38 * energy +
      n2 * 0.22 * energy +
      n3 * 0.12 * energy +
      spike * Math.exp(-t * 14);

    // Occasional bit of square-ish harshness
    if (hashNoise(i + Math.floor(phase * 8)) > 0.97) {
      sample += (sample > 0 ? 1 : -1) * 0.35 * energy;
    }

    sample = Math.tanh(sample * (1.1 + energy * 1.4)) * energy;
    wave[i] = sample;
    sumSq += sample * sample;
  }

  return Math.sqrt(sumSq / n);
}

function drawWavePath(w, midY, amp, step) {
  const n = BUF;
  c2d.beginPath();
  for (let i = 0; i < n; i += step) {
    const x = (i / (n - 1)) * w;
    const y = midY + wave[i] * midY * 0.72 * amp;
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
  // Full framerate while playing for jumpy look; throttle idle
  if (!playing && energy < 0.03 && tNow - lastFrame < 48) {
    rafId = requestAnimationFrame(drawFrame);
    return;
  }
  const dt = Math.min(0.05, Math.max(0.008, (tNow - lastFrame) / 1000 || 0.016));
  lastFrame = tNow;

  const w = canvas.width;
  const h = canvas.height;
  const midY = h * 0.5;
  const accent = cssAccent();

  // Phosphor trail
  c2d.fillStyle = 'rgba(12, 11, 16, 0.2)';
  c2d.fillRect(0, 0, w, h);

  const rms = synthesizeWave(playing, dt);
  const amp = Math.min(1.5, 0.55 + rms * 3.8);
  const step = Math.max(1, Math.floor(BUF / Math.min(BUF, w)));

  if (energy > 0.03) {
    c2d.lineJoin = 'round';
    c2d.lineCap = 'round';
    c2d.strokeStyle = accent;
    c2d.shadowColor = accent;

    // Soft glow pass
    c2d.globalAlpha = 0.2 + rms * 0.45;
    c2d.lineWidth = Math.max(3, (w / 900) * 6);
    c2d.shadowBlur = 16 + rms * 40;
    drawWavePath(w, midY, amp, step);
    c2d.stroke();

    // Crisp core
    c2d.globalAlpha = 0.9;
    c2d.lineWidth = Math.max(1.2, (w / 900) * 2.2);
    c2d.shadowBlur = 6;
    drawWavePath(w, midY, amp, step);
    c2d.stroke();

    c2d.shadowBlur = 0;
    c2d.globalAlpha = 1;
  } else {
    // Idle baseline
    c2d.beginPath();
    c2d.strokeStyle = accent;
    c2d.globalAlpha = 0.12;
    c2d.lineWidth = Math.max(1, w / 1200);
    c2d.shadowColor = accent;
    c2d.shadowBlur = 8;
    const pts = 120;
    const t = tNow * 0.001;
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
  // Snap energy up so the scope kicks immediately on play
  targetEnergy = 1;
  energy = Math.max(energy, 0.55);
  spikeTimer = 0;
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
