import './style.css';
import {
  createTournament,
  pickWinner,
  currentMatch,
  progress,
} from './tournament.js';

const app = document.querySelector('#app');

let state = null;
let loading = false;
let error = '';
let shareMsg = '';

let roundTransition = null;
let transitionTimer = null;

let volumeBySide = { a: 0.25, b: 0.25 };

const previewCache = Object.create(null);

let renderGeneration = 0;
let loadGeneration = 0;

const STORAGE_KEY = 'playlist-bracket-save-v1';

function serializeState(s) {
  if (!s) return null;
  const byeCounts =
    s.byeCounts instanceof Map
      ? Object.fromEntries(s.byeCounts)
      : s.byeCounts && typeof s.byeCounts === 'object'
        ? s.byeCounts
        : {};
  return {
    playlist: s.playlist,
    seeding: s.seeding,
    initialCount: s.initialCount,
    history: s.history,
    byeCounts,
    left: s.left,
    right: s.right,
    finalMatch: s.finalMatch,
    matches: s.matches,
    matchIndex: s.matchIndex,
    roundNumber: s.roundNumber,
    remaining: s.remaining,
    bye: s.bye,
    winners: s.winners,
    champion: s.champion,
    finished: s.finished,
  };
}

function deserializeState(data) {
  if (!data || typeof data !== 'object') return null;
  if (!data.playlist || !data.left || !data.right) return null;
  if (!Array.isArray(data.history) || !Array.isArray(data.matches)) return null;
  if (typeof data.matchIndex !== 'number' || typeof data.roundNumber !== 'number') {
    return null;
  }

  const byeEntries = Object.entries(data.byeCounts || {}).map(([k, v]) => [
    k,
    Number(v) || 0,
  ]);

  return {
    ...data,
    byeCounts: new Map(byeEntries),
    winners: Array.isArray(data.winners) ? data.winners : [],
    finished: Boolean(data.finished),
  };
}

function saveProgress() {
  try {
    if (!state) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    const payload = {
      version: 1,
      savedAt: Date.now(),
      state: serializeState(state),
      volumeBySide: { ...volumeBySide },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
  }
}

function clearSavedProgress() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw);
    const restored = deserializeState(payload?.state);
    if (!restored) {
      clearSavedProgress();
      return null;
    }
    if (
      payload.volumeBySide &&
      typeof payload.volumeBySide.a === 'number' &&
      typeof payload.volumeBySide.b === 'number'
    ) {
      volumeBySide = {
        a: Math.min(1, Math.max(0, payload.volumeBySide.a)),
        b: Math.min(1, Math.max(0, payload.volumeBySide.b)),
      };
    }
    return restored;
  } catch {
    clearSavedProgress();
    return null;
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function brandHeaderHtml(subtitle = '') {
  const sub = subtitle
    ? `<p>${escapeHtml(subtitle)}</p>`
    : '';
  return `
    <header class="app-header">
      <h1>
        <button type="button" class="brand-mark brand-home" data-home aria-label="Back to home">
          <span class="brand-emoji" aria-hidden="true">🎵</span> Playlist Bracket
        </button>
      </h1>
      ${sub}
    </header>
  `;
}

function stageFromRemaining(remaining) {
  if (remaining <= 2) return 'final';
  if (remaining <= 4) return 'semi';
  if (remaining <= 8) return 'quarters';
  if (remaining <= 16) return 'sweet16';
  if (remaining <= 32) return 'round32';
  return 'early';
}

function applyStageVibe(remaining) {
  document.body.dataset.stage = stageFromRemaining(remaining ?? 999);
}

function clearStageVibe() {
  delete document.body.dataset.stage;
}

function clearTransitionTimer() {
  if (transitionTimer != null) {
    clearTimeout(transitionTimer);
    transitionTimer = null;
  }
}

function clearPreviewCache() {
  for (const key of Object.keys(previewCache)) {
    delete previewCache[key];
  }
}

function disposeMedia() {
  for (const side of ['a', 'b', 'champion']) {
    const audio = document.getElementById(`audio-${side}`);
    if (!audio) continue;
    try {
      audio.pause();
      audio.onended = null;
      audio.onerror = null;
      audio.removeAttribute('src');
      audio.load();
    } catch {
    }
  }
}

function scheduleTransition(payload, ms) {
  clearTransitionTimer();
  roundTransition = payload;
  render();
  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    roundTransition = null;
    render();
  }, ms);
}

function render() {
  disposeMedia();
  renderGeneration += 1;
  const gen = renderGeneration;
  document.body.classList.remove('on-setup');

  if (loading) {
    clearStageVibe();
    app.innerHTML = `
      ${brandHeaderHtml()}
      <div class="card loading"><div class="spinner"></div> Loading your bracket…</div>
    `;
    return;
  }

  if (roundTransition) {
    applyStageVibe(roundTransition.remaining);
    renderRoundTransition();
    return;
  }

  if (state?.finished) {
    applyStageVibe(1);
    renderResults(gen);
    return;
  }

  if (state) {
    applyStageVibe(state.remaining);
    renderMatch(gen);
    return;
  }

  clearStageVibe();
  renderSetup();
}

function renderSetup() {
  document.body.classList.add('on-setup');
  app.innerHTML = `
    <div class="setup-page">
      <div class="setup-bg" aria-hidden="true">
        <span class="blob blob-a"></span>
        <span class="blob blob-b"></span>
        <span class="blob blob-c"></span>
        <span class="blob blob-d"></span>
        <span class="swirl swirl-a"></span>
        <span class="swirl swirl-b"></span>
        <span class="swirl swirl-c"></span>
        <span class="shape shape-ring"></span>
        <span class="shape shape-dot-a"></span>
        <span class="shape shape-dot-b"></span>
        <span class="shape shape-dot-c"></span>
        <span class="shape shape-bar"></span>
        <span class="shape shape-arc"></span>
      </div>

      ${brandHeaderHtml()}

      <div class="card setup-card">
        <form class="setup-form" id="setup-form">
          <div class="field">
            <label for="playlist-url">Spotify playlist link</label>
            <input
              id="playlist-url"
              name="url"
              type="url"
              placeholder="https://open.spotify.com/playlist/…"
              required
              autocomplete="off"
            />
          </div>

          <div class="field">
            <label>Matchup order</label>
            <div class="seed-options">
              <div class="seed-option">
                <input type="radio" name="seeding" id="seed-order" value="order" checked />
                <label for="seed-order">
                  Playlist order
                  <span>1st vs 2nd, 3rd vs 4th…</span>
                </label>
              </div>
              <div class="seed-option">
                <input type="radio" name="seeding" id="seed-shuffle" value="shuffle" />
                <label for="seed-shuffle">
                  Shuffle
                  <span>Random matchups</span>
                </label>
              </div>
            </div>
          </div>

          ${
            error
              ? `<div class="error-box" role="alert">${escapeHtml(error)}</div>`
              : `<p class="setup-note">Playlist must be public.</p>`
          }

          <div class="form-actions">
            <button type="submit" id="start-btn">Start tournament</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('setup-form').addEventListener('submit', onStart);
}

function renderRoundTransition() {
  const t = roundTransition;
  if (!t) return;
  const stage = stageFromRemaining(t.remaining);
  const isChampion = Boolean(t.champion);

  if (isChampion) {
    const c = t.champion;
    const art = c.image
      ? `<img class="champ-reveal-art" src="${escapeHtml(c.image)}" alt="" />`
      : `<div class="champ-reveal-art champ-reveal-fallback" aria-hidden="true"></div>`;
    app.innerHTML = `
      <div class="round-transition champ-reveal stage-${escapeHtml(stage)}" role="status" aria-live="polite">
        <p class="champ-reveal-kicker">Champion</p>
        <div class="champ-reveal-frame">
          ${art}
        </div>
        <p class="round-transition-to champ-reveal-title">${escapeHtml(c.name)}</p>
        <p class="round-transition-sub champ-reveal-artist">${escapeHtml(c.artists || '')}</p>
      </div>
    `;
    return;
  }

  app.innerHTML = `
    <div class="round-transition stage-${escapeHtml(stage)}" role="status" aria-live="polite">
      <div class="round-transition-divider" aria-hidden="true"></div>
      <p class="round-transition-to">${escapeHtml(t.toLabel)}</p>
      <p class="round-transition-sub">${t.remaining} songs left</p>
    </div>
  `;
}

function renderMatch(gen) {
  const match = currentMatch(state);
  const p = progress(state);
  const roundDone = Math.max(0, p.matchInRound - 1);
  const roundTotal = Math.max(1, p.matchesInRound);
  const pct = Math.min(100, Math.round((roundDone / roundTotal) * 100));
  const matchesLeft = Math.max(0, p.matchesInRound - roundDone);

  if (!match) {
    app.innerHTML = `<div class="card loading"><div class="spinner"></div> Advancing…</div>`;
    return;
  }

  app.innerHTML = `
    ${brandHeaderHtml(state.playlist.name)}

    <div class="progress-bar-wrap">
      <div class="progress-meta">
        <span><strong>${escapeHtml(p.roundLabel)}</strong></span>
        <span>Match ${p.matchInRound}/${p.matchesInRound} · ${matchesLeft} left</span>
      </div>
      <div class="progress-track" aria-hidden="true">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
    </div>

    <div class="match-grid">
      ${songCardHtml(match.a, 'a')}
      <div class="vs-badge" aria-hidden="true">VS</div>
      ${songCardHtml(match.b, 'b')}
    </div>

    <div class="match-toolbar">
      <button type="button" class="ghost" id="quit-btn">Start over</button>
      <span class="songs-left">${state.remaining} left in bracket</span>
    </div>
  `;

  document.getElementById('pick-a').addEventListener('click', () => onPick('a'));
  document.getElementById('pick-b').addEventListener('click', () => onPick('b'));
  document.getElementById('quit-btn').addEventListener('click', onQuit);
  wireSongPlayers(match.a, match.b, gen);
}

function nameFontSize(name) {
  const len = String(name || '').length;
  if (len > 48) return '0.72rem';
  if (len > 36) return '0.8rem';
  if (len > 26) return '0.88rem';
  if (len > 18) return '0.95rem';
  return '1.05rem';
}

function songCardHtml(song, side) {
  const vol = volumeBySide[side] ?? 0.25;
  const pct = Math.round(vol * 100);
  const nameSize = nameFontSize(song.name);
  const art = song.image
    ? `<img class="cover-art-img" src="${escapeHtml(song.image)}" alt="" />`
    : `<div class="cover-art-fallback" aria-hidden="true">🎵</div>`;
  return `
    <article class="song-card" data-side="${side}">
      <div class="card-action-slot volume-control">
        <span class="volume-icon" aria-hidden="true">🔊</span>
        <input
          type="range"
          class="volume-slider"
          id="vol-${side}"
          min="0"
          max="100"
          step="1"
          value="${pct}"
          aria-label="Volume for ${escapeHtml(song.name)}"
        />
        <span class="volume-pct" id="vol-pct-${side}">${pct}%</span>
      </div>
      <div class="song-meta">
        <h3 style="font-size:${nameSize}">${escapeHtml(song.name)}</h3>
        <p>${escapeHtml(song.artists)}</p>
      </div>
      <div class="cover-player">
        <audio id="audio-${side}" preload="none"></audio>
        <button
          type="button"
          class="cover-play-btn"
          id="play-${side}"
          aria-label="Play preview of ${escapeHtml(song.name)}"
          disabled
        >
          <span class="cover-art">${art}</span>
          <span class="cover-play-icon" id="play-icon-${side}" aria-hidden="true">▶</span>
        </button>
        <p class="preview-status small muted" id="status-${side}" hidden></p>
      </div>
      <button
        type="button"
        class="pick-btn"
        id="pick-${side}"
        title="${escapeHtml(song.name)}"
        style="font-size:${nameSize}"
      >
        ${escapeHtml(song.name)}
      </button>
    </article>
  `;
}

async function ensurePreviewUrl(trackId) {
  if (previewCache[trackId]) return previewCache[trackId];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 400));
      }
      const res = await fetch(`/api/preview/${encodeURIComponent(trackId)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.previewUrl) {
        previewCache[trackId] = data.previewUrl;
        return data.previewUrl;
      }
    } catch {
    }
  }

  return null;
}

function setSideVolume(side, volume01) {
  const vol = Math.min(1, Math.max(0, volume01));
  if (side === 'a' || side === 'b') volumeBySide[side] = vol;
  const pct = Math.round(vol * 100);
  const label = document.getElementById(`vol-pct-${side}`);
  if (label) label.textContent = `${pct}%`;
  const audio = document.getElementById(`audio-${side}`);
  if (audio) audio.volume = vol;
}

function setPlayingUi(side, playing) {
  const icon = document.getElementById(`play-icon-${side}`);
  const btn = document.getElementById(`play-${side}`);
  if (icon) icon.textContent = playing ? '❚❚' : '▶';
  if (btn) btn.classList.toggle('is-playing', playing);
}

function stillCurrent(gen, el) {
  return gen === renderGeneration && el != null && el.isConnected;
}

function wireOnePlayer(side, song, volumeKey, gen) {
  const audio = document.getElementById(`audio-${side}`);
  const playBtn = document.getElementById(`play-${side}`);
  const status = document.getElementById(`status-${side}`);
  const slider = document.getElementById(`vol-${side}`);
  if (!audio || !playBtn) return;

  const initialVol = volumeBySide[volumeKey] ?? 0.25;
  audio.volume = initialVol;

  if (slider) {
    slider.addEventListener('input', () => {
      if (!stillCurrent(gen, slider)) return;
      setSideVolume(side === 'champion' ? 'champion' : volumeKey, Number(slider.value) / 100);
      if (side === 'champion') {
        audio.volume = Number(slider.value) / 100;
        const label = document.getElementById('vol-pct-champion');
        if (label) label.textContent = `${slider.value}%`;
      }
    });
  }

  playBtn.disabled = true;
  if (status) {
    status.hidden = false;
    status.textContent = 'Loading preview…';
  }

  ensurePreviewUrl(song.id).then((url) => {
    if (!stillCurrent(gen, playBtn) || !stillCurrent(gen, audio)) return;

    if (!url) {
      playBtn.disabled = true;
      playBtn.classList.add('no-preview');
      if (status) {
        status.hidden = false;
        status.textContent = 'No preview — try again or open on Spotify';
      }
      playBtn.onclick = () => {
        if (!stillCurrent(gen, playBtn)) return;
        playBtn.disabled = true;
        if (status) {
          status.hidden = false;
          status.textContent = 'Loading preview…';
        }
        delete previewCache[song.id];
        ensurePreviewUrl(song.id).then((retryUrl) => {
          if (!stillCurrent(gen, playBtn) || !stillCurrent(gen, audio)) return;
          if (!retryUrl) {
            playBtn.disabled = false;
            if (status) {
              status.hidden = false;
              status.textContent = 'No preview available';
            }
            return;
          }
          if (status) status.hidden = true;
          setupPreviewPlayback(side, song, volumeKey, gen, audio, playBtn, status, retryUrl);
        });
      };
      playBtn.disabled = false;
      return;
    }

    if (status) status.hidden = true;
    setupPreviewPlayback(side, song, volumeKey, gen, audio, playBtn, status, url);
  });
}

function setupPreviewPlayback(side, song, volumeKey, gen, audio, playBtn, status, url) {
  audio.src = url;
  playBtn.disabled = false;
  playBtn.classList.remove('no-preview');

  playBtn.onclick = async () => {
    if (!stillCurrent(gen, playBtn) || !stillCurrent(gen, audio)) return;

    if (!audio.paused) {
      audio.pause();
      setPlayingUi(side, false);
      return;
    }

    for (const other of ['a', 'b', 'champion']) {
      if (other === side) continue;
      const o = document.getElementById(`audio-${other}`);
      if (o && !o.paused) {
        o.pause();
        setPlayingUi(other, false);
      }
    }

    try {
      audio.volume =
        side === 'champion'
          ? Number(document.getElementById('vol-champion')?.value || 25) / 100
          : volumeBySide[volumeKey] ?? 0.25;
      await audio.play();
      if (!stillCurrent(gen, playBtn)) {
        audio.pause();
        return;
      }
      setPlayingUi(side, true);
    } catch {
      if (stillCurrent(gen, status) && status) {
        status.hidden = false;
        status.textContent = 'Could not play preview';
      }
    }
  };

  audio.onended = () => {
    if (!stillCurrent(gen, audio)) return;
    setPlayingUi(side, false);
  };
}

function wireSongPlayers(songA, songB, gen) {
  wireOnePlayer('a', songA, 'a', gen);
  wireOnePlayer('b', songB, 'b', gen);
}

function renderResults(gen) {
  const { playlist, champion, history, initialCount } = state;
  const bracketHtml = buildBracketHtml(history, champion);

  app.innerHTML = `
    ${brandHeaderHtml('Tournament complete')}

    <div class="card results" id="results-card">
      <div class="results-badge">🏆 Champion</div>

      <div class="playlist-hero">
        ${
          playlist.image
            ? `<img src="${escapeHtml(playlist.image)}" alt="" width="120" height="120" />`
            : ''
        }
        <h2>${escapeHtml(playlist.name)}</h2>
        <p class="small muted">${initialCount} songs · ${history.length} matchups</p>
      </div>

      <div class="champion-block">
        <p class="label">Winner</p>
        <h3>${escapeHtml(champion.name)}</h3>
        <p class="artists">${escapeHtml(champion.artists)}</p>
        <div class="card-action-slot volume-control champion-volume">
          <span class="volume-icon" aria-hidden="true">🔊</span>
          <input
            type="range"
            class="volume-slider"
            id="vol-champion"
            min="0"
            max="100"
            step="1"
            value="${Math.round((volumeBySide.a ?? 0.25) * 100)}"
            aria-label="Volume for champion"
          />
          <span class="volume-pct" id="vol-pct-champion">${Math.round((volumeBySide.a ?? 0.25) * 100)}%</span>
        </div>
        <div class="cover-player champion-cover">
          <audio id="audio-champion" preload="none"></audio>
          <button
            type="button"
            class="cover-play-btn"
            id="play-champion"
            aria-label="Play preview of ${escapeHtml(champion.name)}"
            disabled
          >
            <span class="cover-art">
              ${
                champion.image
                  ? `<img class="cover-art-img" src="${escapeHtml(champion.image)}" alt="" />`
                  : `<div class="cover-art-fallback" aria-hidden="true">🎵</div>`
              }
            </span>
            <span class="cover-play-icon" id="play-icon-champion" aria-hidden="true">▶</span>
          </button>
          <p class="preview-status small muted" id="status-champion" hidden></p>
        </div>
      </div>

      <p class="share-toast" id="share-toast" aria-live="polite">${escapeHtml(shareMsg)}</p>

      <div class="results-actions">
        <button type="button" id="share-btn">Share results</button>
        <button type="button" class="secondary" id="copy-btn">Copy summary</button>
        <button type="button" class="secondary" id="again-btn">New tournament</button>
      </div>

      <section class="bracket-section" id="bracket-section">
        <h3>Tournament bracket</h3>
        ${bracketHtml}
      </section>
    </div>
  `;

  document.getElementById('share-btn').addEventListener('click', onShare);
  document.getElementById('copy-btn').addEventListener('click', onCopySummary);
  document.getElementById('again-btn').addEventListener('click', onQuit);
  wireOnePlayer('champion', champion, 'a', gen);
}

function mmRoundLabel(matches, initialCount) {
  if (matches.length === 1) return 'Final';
  if (matches.length === 2) return 'Semis';
  if (matches.length === 4) return 'Quarters';
  if (matches.length === 8) return 'Round of 16';
  if (matches.length === 16) return 'Round of 32';
  if (matches.length === 32) return 'Round of 64';
  // Column is one half of a wave — estimate total field from both halves when possible
  const songsThisColumn = matches.length * 2;
  if (initialCount && songsThisColumn * 2 >= initialCount - 2) {
    return `${initialCount} songs`;
  }
  return `${songsThisColumn} songs`;
}

function mmCoverHtml(song, role) {
  const tip = `${song.name}${song.artists ? ` — ${song.artists}` : ''}`;
  const inner = song.image
    ? `<img src="${escapeHtml(song.image)}" alt="" loading="lazy" draggable="false" />`
    : `<span class="mm-fallback" aria-hidden="true">🎵</span>`;
  return `
    <div
      class="mm-cover mm-${role}"
      data-tip="${escapeHtml(tip)}"
      aria-label="${escapeHtml(tip)}"
    >
      <div class="mm-cover-inner">${inner}</div>
    </div>
  `;
}

function mmMatchHtml(m) {
  const aWin = m.winnerId === m.a.id;
  return `
    <div class="mm-match">
      ${mmCoverHtml(m.a, aWin ? 'winner' : 'loser')}
      <span class="mm-vs" aria-hidden="true">vs</span>
      ${mmCoverHtml(m.b, aWin ? 'loser' : 'winner')}
    </div>
  `;
}

function mmRoundColumn(matches, label, sideClass = '') {
  if (!matches.length) return '';
  const densityHint =
    matches.length > 16 ? 'mm-dense' : matches.length > 8 ? 'mm-mid' : '';
  return `
    <div class="mm-round ${sideClass} ${densityHint}">
      <div class="mm-round-label">${escapeHtml(label)}</div>
      <div class="mm-round-matches">
        ${matches.map(mmMatchHtml).join('')}
      </div>
    </div>
  `;
}

function buildBracketHtml(history, champion) {
  if (!history.length) {
    return '<p class="muted small">No matches recorded.</p>';
  }

  const initialCount = state?.initialCount || 0;
  const leftByWave = new Map();
  const rightByWave = new Map();
  const crossByWave = new Map();
  const finals = [];

  for (const m of history) {
    if (m.region === 'final') {
      finals.push(m);
      continue;
    }
    if (m.region === 'cross') {
      if (!crossByWave.has(m.round)) crossByWave.set(m.round, []);
      crossByWave.get(m.round).push(m);
      continue;
    }
    const map = m.region === 'right' ? rightByWave : leftByWave;
    if (!map.has(m.round)) map.set(m.round, []);
    map.get(m.round).push(m);
  }

  const leftWaves = [...leftByWave.keys()].sort((a, b) => a - b);
  const rightWaves = [...rightByWave.keys()].sort((a, b) => a - b);

  function waveLabel(wave, matches) {
    const leftN = (leftByWave.get(wave) || []).length;
    const rightN = (rightByWave.get(wave) || []).length;
    const crossN = (crossByWave.get(wave) || []).length;
    // Total songs still in at start of this wave ≈ 2*(left+right matches) + free byes + 2*cross
    // Approximate from both halves' match counts
    const approxSongs = (leftN + rightN) * 2 + crossN * 2;
    if (matches.length === 1 && leftN + rightN + crossN === 1) {
      return mmRoundLabel(matches, initialCount);
    }
    if (approxSongs === 2) return 'Final';
    if (approxSongs === 4) return 'Semis';
    if (approxSongs === 8) return 'Quarters';
    if (approxSongs === 16) return 'Round of 16';
    if (approxSongs === 32) return 'Round of 32';
    if (approxSongs === 64) return 'Round of 64';
    if (wave === Math.min(...[...leftWaves, ...rightWaves, 999]) && initialCount) {
      return `${initialCount} songs`;
    }
    if (approxSongs > 0) return `${approxSongs} songs left`;
    return mmRoundLabel(matches, initialCount);
  }

  const leftCols = leftWaves
    .map((w) => {
      const matches = leftByWave.get(w);
      return mmRoundColumn(matches, waveLabel(w, matches), 'mm-side-left');
    })
    .join('');

  const rightCols = [...rightWaves]
    .reverse()
    .map((w) => {
      const matches = rightByWave.get(w);
      return mmRoundColumn(matches, waveLabel(w, matches), 'mm-side-right');
    })
    .join('');

  const finalMatch = finals[finals.length - 1];
  const crossCols = [...crossByWave.keys()]
    .sort((a, b) => a - b)
    .map((w) => {
      const matches = crossByWave.get(w);
      return mmRoundColumn(matches, 'Play-in', 'mm-cross-round');
    })
    .join('');

  const centerHtml = `
    <div class="mm-center">
      ${crossCols}
      ${
        finalMatch
          ? `
        <div class="mm-round mm-final-round">
          <div class="mm-round-label">Final</div>
          <div class="mm-round-matches">${mmMatchHtml(finalMatch)}</div>
        </div>
      `
          : ''
      }
      ${
        champion
          ? `
        <div class="mm-round mm-champ-round">
          <div class="mm-round-label">Champion</div>
          <div class="mm-round-matches">
            <div class="mm-match mm-champ-match">
              ${mmCoverHtml(champion, 'winner')}
              <span class="mm-champ-crown" aria-hidden="true">🏆</span>
            </div>
          </div>
        </div>
      `
          : ''
      }
    </div>
  `;

  const maxM = Math.max(
    1,
    ...[...leftByWave.values(), ...rightByWave.values()].map((x) => x.length)
  );
  const density = maxM > 24 ? 'mm-dense' : maxM > 12 ? 'mm-mid' : 'mm-roomy';

  return `
    <div class="mm-bracket-scroll">
      <div class="mm-bracket mm-classic ${density}">
        <div class="mm-half mm-half-left">${leftCols}</div>
        ${centerHtml}
        <div class="mm-half mm-half-right">${rightCols}</div>
      </div>
    </div>
  `;
}

function resultsSummaryText() {
  if (!state?.champion) return '';
  const { playlist, champion, history, initialCount } = state;
  return [
    `Playlist Bracket results`,
    `Playlist: ${playlist.name}`,
    `Champion: ${champion.name} — ${champion.artists}`,
    `Songs: ${initialCount} · Matchups: ${history.length}`,
    playlist.spotifyUrl ? `Playlist: ${playlist.spotifyUrl}` : '',
    champion.spotifyUrl ? `Winner: ${champion.spotifyUrl}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function onStart(e) {
  e.preventDefault();
  error = '';
  const form = e.target;
  const url = form.url.value.trim();
  const seeding = form.seeding.value === 'shuffle' ? 'shuffle' : 'order';

  loadGeneration += 1;
  const myLoad = loadGeneration;

  clearTransitionTimer();
  roundTransition = null;
  clearPreviewCache();
  state = null;

  loading = true;
  render();

  try {
    const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Failed to load playlist (${res.status})`);
    }
    if (myLoad !== loadGeneration) return;

    state = createTournament(data, data.tracks, seeding);
    shareMsg = '';
    saveProgress();
  } catch (err) {
    if (myLoad !== loadGeneration) return;
    error = err.message || 'Could not start tournament.';
    state = null;
    clearSavedProgress();
  } finally {
    if (myLoad !== loadGeneration) return;
    loading = false;
    render();
  }
}

function onPick(side) {
  if (!state || roundTransition) return;

  const fromLabel = progress(state).roundLabel;
  const prevRound = state.roundNumber;
  const prevRegion = currentMatch(state)?.region;

  state = pickWinner(state, side);
  shareMsg = '';
  saveProgress();

  if (state.finished) {
    scheduleTransition(
      {
        fromLabel,
        toLabel: 'Champion',
        remaining: 1,
        champion: state.champion,
      },
      4200
    );
    return;
  }

  const nextMatch = currentMatch(state);
  const waveChanged = state.roundNumber !== prevRound;
  const enteredFinal = nextMatch?.region === 'final' && prevRegion !== 'final';

  if (waveChanged || enteredFinal) {
    scheduleTransition(
      {
        fromLabel,
        toLabel: progress(state).roundLabel,
        remaining: state.remaining,
      },
      2200
    );
    return;
  }

  render();
}

function onQuit() {
  loadGeneration += 1;
  clearTransitionTimer();
  roundTransition = null;
  clearPreviewCache();
  clearSavedProgress();
  state = null;
  error = '';
  shareMsg = '';
  clearStageVibe();
  render();
}

function goHome() {
  onQuit();
}

async function onCopySummary() {
  if (!state?.champion) return;
  try {
    await navigator.clipboard.writeText(resultsSummaryText());
    shareMsg = 'Summary copied to clipboard.';
  } catch {
    shareMsg = 'Could not copy — try selecting the text manually.';
  }
  render();
}

async function onShare() {
  if (!state?.champion) return;
  const text = resultsSummaryText();
  const title = `Champion: ${state.champion.name}`;

  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      shareMsg = 'Shared.';
      render();
      return;
    } catch (err) {
      if (err?.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    shareMsg = 'Share not available — summary copied instead.';
  } catch {
    shareMsg = 'Could not share or copy automatically.';
  }
  render();
}

app.addEventListener('click', (e) => {
  if (!e.target.closest('[data-home]')) return;
  e.preventDefault();
  goHome();
});

const restored = loadProgress();
if (restored) {
  state = restored;
  roundTransition = null;
}

render();
