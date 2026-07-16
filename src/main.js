import './style.css';
import {
  createTournament,
  pickWinner,
  currentMatch,
  progress,
} from './tournament.js';
import {
  prepareMediaElement,
  connectMediaElement,
  resumeAudioContext,
  kickScopeFromPlayback,
  startScope,
  onMediaDisposed,
} from './scope.js';
import {
  isYouTubeTrack,
  youtubeVideoId,
  loadYouTubeApi,
  mountYouTubePlayer,
  destroyYouTubePlayer,
  destroyAllYouTubePlayers,
  pauseAllYouTubeExcept,
  setYouTubeVolume,
  youtubeIsPlaying,
  playYouTube,
  pauseYouTube,
  getYouTubeCurrentTime,
  getYouTubeDuration,
  seekYouTube,
  formatYouTubeTime,
} from './youtube-players.js';

const app = document.querySelector('#app');

let state = null;
let loading = false;
let error = '';
let roundTransition = null;
let transitionTimer = null;
let saveTimer = null;

/** In-flight champion bed load so we never double-set src (which restarts audio). */
let championBedLoad = null; // { id, promise }

/** Active volume fades (key → rAF id). */
const fadeRafs = new Map();
const FADE_IN_MS = 550;
const FADE_OUT_MS = 500;

let volumeBySide = { a: 0.25, b: 0.25 };

/** Last volume the user set for each track id (0–1). */
const volumeByTrackId = Object.create(null);

/** Resolved preview URLs by track id. */
const previewCache = Object.create(null);
/** In-flight preview fetches so concurrent callers share one request. */
const previewInflight = Object.create(null);

let renderGeneration = 0;
let loadGeneration = 0;

/** Original playlist order for transition music (1st, 2nd, 3rd…). */
let playlistTracks = [];
let transitionSongIndex = 0;

const DEFAULT_MATCH_VOLUME = 0.25;
const DEFAULT_TRANSITION_VOLUME = 0.1;
const SAVE_DEBOUNCE_MS = 350;
const MAX_CACHED_PREVIEWS = 400;
const MAX_TRACK_VOLUMES = 800;

const STORAGE_KEY = 'playlist-bracket-save-v1';

function isSongLike(s) {
  return s && typeof s === 'object' && typeof s.id === 'string' && s.id.length > 0;
}

function isMatchLike(m) {
  return m && typeof m === 'object' && isSongLike(m.a) && isSongLike(m.b);
}

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
    finalMatch: s.finalMatch || null,
    crossMatch: s.crossMatch || null,
    crossWinner: s.crossWinner || null,
    matches: s.matches,
    matchIndex: s.matchIndex,
    roundNumber: s.roundNumber,
    remaining: s.remaining,
    bye: s.bye || null,
    winners: s.winners,
    champion: s.champion || null,
    finished: s.finished,
  };
}

function deserializeState(data) {
  if (!data || typeof data !== 'object') return null;
  if (!data.playlist || typeof data.playlist !== 'object') return null;
  if (!data.left || !data.right || typeof data.left !== 'object' || typeof data.right !== 'object') {
    return null;
  }
  if (!Array.isArray(data.history) || !Array.isArray(data.matches)) return null;
  if (!Number.isFinite(data.matchIndex) || !Number.isFinite(data.roundNumber)) {
    return null;
  }
  if (!Number.isFinite(data.initialCount) || data.initialCount < 2) return null;

  const finished = Boolean(data.finished);
  if (finished) {
    if (!isSongLike(data.champion)) return null;
  } else {
    // Must have a playable current match — index past end / empty queue is corrupt
    if (data.matches.length === 0) return null;
    if (data.matchIndex < 0 || data.matchIndex >= data.matches.length) return null;
    for (const m of data.matches) {
      if (!isMatchLike(m)) return null;
    }
  }

  const byeEntries = Object.entries(data.byeCounts || {}).map(([k, v]) => [
    String(k),
    Number(v) || 0,
  ]);

  return {
    ...data,
    byeCounts: new Map(byeEntries),
    winners: Array.isArray(data.winners) ? data.winners : [],
    crossMatch: data.crossMatch && isMatchLike(data.crossMatch) ? data.crossMatch : null,
    crossWinner: isSongLike(data.crossWinner) ? data.crossWinner : null,
    finalMatch: data.finalMatch && isMatchLike(data.finalMatch) ? data.finalMatch : null,
    champion: isSongLike(data.champion) ? data.champion : null,
    matchIndex: Math.max(0, Math.floor(data.matchIndex)),
    roundNumber: Math.max(1, Math.floor(data.roundNumber)),
    remaining: Number.isFinite(data.remaining)
      ? Math.max(1, Math.floor(data.remaining))
      : Math.max(1, data.initialCount - data.history.length),
    finished,
  };
}

function saveProgressNow() {
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
      volumeByTrackId: { ...volumeByTrackId },
      playlistTracks,
      transitionSongIndex,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota or private mode — drop oldest track volumes and retry once
    try {
      const ids = Object.keys(volumeByTrackId);
      if (ids.length > 50) {
        for (const id of ids.slice(0, Math.floor(ids.length / 2))) {
          delete volumeByTrackId[id];
        }
        if (state) {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
              version: 1,
              savedAt: Date.now(),
              state: serializeState(state),
              volumeBySide: { ...volumeBySide },
              volumeByTrackId: { ...volumeByTrackId },
              playlistTracks,
              transitionSongIndex,
            })
          );
        }
      }
    } catch {
    }
  }
}

function saveProgress({ immediate = false } = {}) {
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (immediate) {
    saveProgressNow();
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveProgressNow();
  }, SAVE_DEBOUNCE_MS);
}

function clearSavedProgress() {
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
  }
}

function rememberTrackVolume(trackId, volume01) {
  if (!trackId) return;
  const vol = Math.min(1, Math.max(0, volume01));
  volumeByTrackId[trackId] = vol;
  const keys = Object.keys(volumeByTrackId);
  if (keys.length > MAX_TRACK_VOLUMES) {
    for (const id of keys.slice(0, keys.length - MAX_TRACK_VOLUMES)) {
      delete volumeByTrackId[id];
    }
  }
}

function volumeForTrack(trackId, fallback = DEFAULT_TRANSITION_VOLUME) {
  if (trackId && typeof volumeByTrackId[trackId] === 'number') {
    return Math.min(1, Math.max(0, volumeByTrackId[trackId]));
  }
  return fallback;
}

function clearTrackVolumes() {
  for (const key of Object.keys(volumeByTrackId)) {
    delete volumeByTrackId[key];
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
    if (payload.volumeByTrackId && typeof payload.volumeByTrackId === 'object') {
      clearTrackVolumes();
      let count = 0;
      for (const [id, v] of Object.entries(payload.volumeByTrackId)) {
        if (typeof v !== 'number' || !id) continue;
        volumeByTrackId[id] = Math.min(1, Math.max(0, v));
        count += 1;
        if (count >= MAX_TRACK_VOLUMES) break;
      }
    }
    if (Array.isArray(payload.playlistTracks)) {
      playlistTracks = payload.playlistTracks.filter(isSongLike);
    }
    if (typeof payload.transitionSongIndex === 'number' && Number.isFinite(payload.transitionSongIndex)) {
      transitionSongIndex = Math.max(0, Math.floor(payload.transitionSongIndex));
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
  for (const key of Object.keys(previewInflight)) {
    delete previewInflight[key];
  }
}

function hardStopAudio(audio) {
  if (!audio) return;
  try {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.oncanplay = null;
    audio.ontimeupdate = null;
    audio.onplay = null;
    audio.onpause = null;
    audio.removeAttribute('src');
    // Empty source + load aborts network and frees the buffer
    audio.load();
  } catch {
  }
}

function cancelFade(key) {
  const id = fadeRafs.get(key);
  if (id != null) cancelAnimationFrame(id);
  fadeRafs.delete(key);
}

function cancelAllFades() {
  for (const key of [...fadeRafs.keys()]) cancelFade(key);
}

function easeSmooth(t) {
  // Smoothstep
  return t * t * (3 - 2 * t);
}

/** Fade an HTMLMediaElement volume from → to over ms. */
function fadeHtmlVolume(audio, from, to, ms, key) {
  return new Promise((resolve) => {
    if (!audio) {
      resolve();
      return;
    }
    cancelFade(key);
    const startVol = Math.min(1, Math.max(0, from));
    const endVol = Math.min(1, Math.max(0, to));
    const start = performance.now();
    try {
      audio.volume = startVol;
    } catch {
    }

    const tick = (now) => {
      const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
      const v = startVol + (endVol - startVol) * easeSmooth(t);
      try {
        audio.volume = v;
      } catch {
      }
      if (t < 1) {
        fadeRafs.set(key, requestAnimationFrame(tick));
      } else {
        fadeRafs.delete(key);
        try {
          audio.volume = endVol;
        } catch {
        }
        resolve();
      }
    };
    fadeRafs.set(key, requestAnimationFrame(tick));
  });
}

/** Fade a YouTube player 0–1 volume over ms. */
function fadeYouTubeVolume(side, from, to, ms, key) {
  return new Promise((resolve) => {
    cancelFade(key);
    const startVol = Math.min(1, Math.max(0, from));
    const endVol = Math.min(1, Math.max(0, to));
    const start = performance.now();
    setYouTubeVolume(side, startVol);

    const tick = (now) => {
      const t = ms <= 0 ? 1 : Math.min(1, (now - start) / ms);
      setYouTubeVolume(side, startVol + (endVol - startVol) * easeSmooth(t));
      if (t < 1) {
        fadeRafs.set(key, requestAnimationFrame(tick));
      } else {
        fadeRafs.delete(key);
        setYouTubeVolume(side, endVol);
        resolve();
      }
    };
    fadeRafs.set(key, requestAnimationFrame(tick));
  });
}

/**
 * Detach currently playing match audio from the card, fade to silence, remove.
 * Lets the transition screen render without a hard cut of the previous track.
 */
function orphanAndFadeOutMatchAudio() {
  const jobs = [];
  for (const side of ['a', 'b']) {
    const el = document.getElementById(`audio-${side}`);
    if (el && !el.paused && el.currentSrc) {
      const from = el.volume;
      const fadeId = `fade-match-${side}-${Date.now()}`;
      el.id = fadeId;
      document.body.appendChild(el);
      jobs.push(
        fadeHtmlVolume(el, from, 0, FADE_OUT_MS, fadeId).then(() => {
          hardStopAudio(el);
          try {
            el.remove();
          } catch {
          }
        })
      );
    }
    // YouTube match players: fade then pause (DOM may be wiped by render after)
    if (youtubeIsPlaying(side)) {
      const slider = document.getElementById(`vol-${side}`);
      const vol = slider ? Number(slider.value) / 100 : 0.25;
      jobs.push(
        fadeYouTubeVolume(side, vol, 0, FADE_OUT_MS, `yt-fade-match-${side}`).then(() => {
          pauseYouTube(side);
        })
      );
    }
  }
  return Promise.all(jobs);
}

/** Fade out transition stinger (HTML or YouTube) then stop it. */
async function fadeOutTransitionMusic() {
  const jobs = [];

  const audio = document.getElementById('audio-transition');
  if (audio && audio.currentSrc && !audio.paused) {
    const from = audio.volume;
    jobs.push(
      fadeHtmlVolume(audio, from, 0, FADE_OUT_MS, 'html-transition-out').then(() => {
        hardStopAudio(audio);
        if (audio.parentNode) {
          try {
            audio.parentNode.removeChild(audio);
          } catch {
          }
        }
      })
    );
  }

  if (youtubeIsPlaying('transition')) {
    const sliderVol = DEFAULT_TRANSITION_VOLUME;
    jobs.push(
      fadeYouTubeVolume('transition', sliderVol, 0, FADE_OUT_MS, 'yt-transition-out').then(
        () => {
          pauseYouTube('transition');
          hideYouTubeFloat('transition');
          destroyYouTubePlayer('transition');
        }
      )
    );
  }

  await Promise.all(jobs);
}

function disposeMedia({ removeTransition = false } = {}) {
  for (const side of ['a', 'b', 'champion', 'transition']) {
    const audio = document.getElementById(`audio-${side}`);
    if (audio) {
      hardStopAudio(audio);
      if (side === 'transition' && removeTransition && audio.parentNode) {
        try {
          audio.parentNode.removeChild(audio);
        } catch {
        }
      }
    }
    // Drop ephemeral YouTube iframes (not the champion bed)
    if (side !== 'champion-bed') destroyYouTubePlayer(side);
  }
  destroyYouTubePlayer('transition');
  onMediaDisposed();
}

function pauseAllHtmlAudioExcept(exceptSide = null) {
  for (const side of ['a', 'b', 'champion', 'transition']) {
    if (exceptSide && side === exceptSide) continue;
    const o = document.getElementById(`audio-${side}`);
    if (o && !o.paused) {
      o.pause();
      if (side !== 'transition') setPlayingUi(side, false);
    }
  }
  const bed = document.getElementById('audio-champion-bed');
  if (exceptSide !== 'champion-bed' && bed && !bed.paused) {
    bed.pause();
  }
}

/** Persistent champion player — lives outside #app so re-renders don't kill it. */
function getChampionBed() {
  let audio = document.getElementById('audio-champion-bed');
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'audio-champion-bed';
    audio.setAttribute('playsinline', '');
    audio.preload = 'auto';
    audio.loop = true;
    document.body.appendChild(audio);
  }
  return audio;
}

function championBedIsFor(songId) {
  const audio = document.getElementById('audio-champion-bed');
  return Boolean(audio && songId && audio.dataset.trackId === songId && audio.currentSrc);
}

function championBedIsPlaying(songId) {
  const audio = document.getElementById('audio-champion-bed');
  return Boolean(
    audio &&
      songId &&
      audio.dataset.trackId === songId &&
      audio.currentSrc &&
      !audio.paused &&
      !audio.ended
  );
}

function stopChampionBed() {
  championBedLoad = null;
  destroyYouTubePlayer('champion-bed');
  destroyYouTubePlayer('champion');
  hideYouTubeFloat('champion-bed');
  hideYouTubeFloat('transition');
  const shell = document.getElementById('yt-shell-champion-bed');
  if (shell?.parentNode) {
    try {
      shell.parentNode.removeChild(shell);
    } catch {
    }
  }
  const audio = document.getElementById('audio-champion-bed');
  if (!audio) return;
  try {
    audio.pause();
    audio.onended = null;
    audio.onerror = null;
    audio.onplay = null;
    audio.onpause = null;
    delete audio.dataset.trackId;
    audio.removeAttribute('src');
    audio.load();
  } catch {
  }
}

/**
 * Prefer a visible on-page host (match/results miniplayer). Fall back to a
 * fixed corner miniplayer so champion/transition audio still has a home.
 */
function ensureYouTubeHost(side, { visibleMini = false } = {}) {
  let host = document.getElementById(`yt-${side}`);
  if (host) return host;

  // Corner floating miniplayer (champion bed / transition)
  let shell = document.getElementById(`yt-shell-${side}`);
  if (!shell) {
    shell = document.createElement('div');
    shell.id = `yt-shell-${side}`;
    shell.className = visibleMini
      ? 'yt-float-mini'
      : 'yt-float-mini yt-float-mini-hidden';
    shell.innerHTML = `
      <div class="yt-float-frame">
        <div class="yt-host" id="yt-${side}"></div>
      </div>
      <button type="button" class="yt-float-close" data-yt-close="${side}" aria-label="Hide video">×</button>
    `;
    document.body.appendChild(shell);
    shell.querySelector('[data-yt-close]')?.addEventListener('click', () => {
      shell.classList.add('yt-float-mini-hidden');
    });
  }
  if (visibleMini) shell.classList.remove('yt-float-mini-hidden');
  return document.getElementById(`yt-${side}`);
}

function showYouTubeFloat(side) {
  const shell = document.getElementById(`yt-shell-${side}`);
  if (shell) shell.classList.remove('yt-float-mini-hidden');
}

function hideYouTubeFloat(side) {
  const shell = document.getElementById(`yt-shell-${side}`);
  if (shell) shell.classList.add('yt-float-mini-hidden');
}

/**
 * Champion bed outside #app — starts on reveal, keeps playing into results.
 * Spotify → HTML audio + Web Audio scope; YouTube → IFrame player.
 */
function playChampionBed(song, volume01 = DEFAULT_TRANSITION_VOLUME) {
  if (!isSongLike(song)) return Promise.resolve(null);

  const vol = volumeForTrack(song.id, volume01);
  rememberTrackVolume(song.id, vol);

  if (isYouTubeTrack(song)) {
    return playChampionBedYouTube(song, vol);
  }

  // Stop any YT bed if switching sources mid-session
  destroyYouTubePlayer('champion-bed');

  const audio = getChampionBed();
  audio.loop = true;
  audio.volume = vol;

  if (audio.dataset.trackId === song.id && audio.currentSrc) {
    if (audio.paused) {
      return resumeAudioContext()
        .then(() => audio.play())
        .then(() => {
          kickScopeFromPlayback();
          return audio;
        })
        .catch(() => audio);
    }
    kickScopeFromPlayback();
    return Promise.resolve(audio);
  }

  if (championBedLoad?.id === song.id) {
    return championBedLoad.promise.then((el) => {
      if (el) el.volume = vol;
      return el;
    });
  }

  audio.dataset.trackId = song.id;

  const promise = ensurePreviewUrl(song.id)
    .then(async (url) => {
      if (!url) {
        delete audio.dataset.trackId;
        return null;
      }
      if (audio.dataset.trackId !== song.id) return null;

      if (audio.dataset.trackId === song.id && audio.currentSrc) {
        audio.volume = vol;
        if (audio.paused) {
          await resumeAudioContext();
          await audio.play().catch(() => {});
          kickScopeFromPlayback();
        }
        return audio;
      }

      prepareMediaElement(audio);
      audio.loop = true;
      audio.volume = vol;
      audio.src = url;
      connectMediaElement(audio);
      await resumeAudioContext();
      await audio.play().catch(() => {});
      kickScopeFromPlayback();
      return audio;
    })
    .catch(() => {
      if (audio.dataset.trackId === song.id) delete audio.dataset.trackId;
      return null;
    })
    .finally(() => {
      if (championBedLoad?.id === song.id) championBedLoad = null;
    });

  championBedLoad = { id: song.id, promise };
  return promise;
}

function playChampionBedYouTube(song, vol) {
  const vid = youtubeVideoId(song);
  if (!vid) return Promise.resolve(null);

  // Prefer visible results miniplayer if present; else floating corner player
  const preferredSide = document.getElementById('yt-champion')
    ? 'champion'
    : 'champion-bed';

  if (youtubeIsPlaying(preferredSide) && championBedLoad?.id === song.id) {
    setYouTubeVolume(preferredSide, vol);
    if (preferredSide === 'champion-bed') showYouTubeFloat('champion-bed');
    return Promise.resolve(true);
  }

  if (championBedLoad?.id === song.id && championBedLoad.promise) {
    return championBedLoad.promise.then(() => {
      setYouTubeVolume(preferredSide, vol);
      return true;
    });
  }

  if (preferredSide === 'champion-bed') {
    ensureYouTubeHost('champion-bed', { visibleMini: true });
  }

  const audio = document.getElementById('audio-champion-bed');
  if (audio) {
    try {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    } catch {
    }
  }

  pauseAllHtmlAudioExcept(null);
  pauseAllYouTubeExcept(preferredSide);

  const promise = mountYouTubePlayer(preferredSide, vid, {
    volume01: vol,
    autoplay: true,
    onPlaying: () => {
      if (preferredSide === 'champion-bed') showYouTubeFloat('champion-bed');
      const cover = document.getElementById('cover-player-champion');
      if (cover) cover.classList.add('is-yt-playing');
    },
  }).then((p) => {
    setYouTubeVolume(preferredSide, vol);
    if (preferredSide === 'champion-bed') showYouTubeFloat('champion-bed');
    return p;
  });

  championBedLoad = { id: song.id, promise };
  promise.finally(() => {
    if (championBedLoad?.id === song.id) championBedLoad = null;
  });
  return promise;
}

function takeNextTransitionSong() {
  if (!playlistTracks.length) return null;
  const song = playlistTracks[transitionSongIndex % playlistTracks.length];
  transitionSongIndex += 1;
  saveProgress({ immediate: true });
  return song;
}

function playAutoPreview(song, volume, gen) {
  if (!song?.id) return;
  const targetVol = volumeForTrack(song.id, volume);

  if (isYouTubeTrack(song)) {
    const vid = youtubeVideoId(song);
    if (!vid) return;
    ensureYouTubeHost('transition', { visibleMini: true });
    if (gen !== renderGeneration) return;
    pauseAllHtmlAudioExcept(null);
    pauseAllYouTubeExcept('transition');
    // Start silent, then fade in
    mountYouTubePlayer('transition', vid, {
      volume01: 0,
      autoplay: true,
      onPlaying: () => {
        showYouTubeFloat('transition');
        fadeYouTubeVolume('transition', 0, targetVol, FADE_IN_MS, 'yt-transition-in');
      },
    }).catch(() => {});
    return;
  }

  ensurePreviewUrl(song.id).then((url) => {
    if (gen !== renderGeneration || !url) return;
    let audio = document.getElementById('audio-transition');
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-transition';
      audio.setAttribute('playsinline', '');
      audio.preload = 'auto';
      document.body.appendChild(audio);
    }
    try {
      hardStopAudio(audio);
      prepareMediaElement(audio);
      audio.volume = 0;
      audio.src = url;
      connectMediaElement(audio);
      resumeAudioContext().then(() => {
        audio
          .play()
          .then(() => {
            kickScopeFromPlayback();
            fadeHtmlVolume(audio, 0, targetVol, FADE_IN_MS, 'html-transition-in');
          })
          .catch(() => {});
      });
    } catch {
    }
  });
}

function scheduleTransition(payload, ms) {
  clearTransitionTimer();
  cancelFade('html-transition-in');
  cancelFade('html-transition-out');
  cancelFade('yt-transition-in');
  cancelFade('yt-transition-out');

  // Soften the handoff from the match into the stinger
  orphanAndFadeOutMatchAudio();

  roundTransition = payload;
  const isChampionReveal = Boolean(payload.champion);
  render();
  const gen = renderGeneration;

  if (isChampionReveal) {
    // Champion bed: start quiet and fade up (Spotify HTML path handles vol inside play)
    playChampionBedFaded(
      payload.champion,
      volumeForTrack(payload.champion.id, DEFAULT_TRANSITION_VOLUME)
    );
  } else if (payload.transitionSong) {
    playAutoPreview(payload.transitionSong, DEFAULT_TRANSITION_VOLUME, gen);
  }

  // Begin fade-out before the transition screen ends so the next view is quiet
  const fadeLead = Math.min(FADE_OUT_MS, Math.max(0, ms - 80));
  const fadeAt = Math.max(0, ms - fadeLead);

  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    const keepChampion = Boolean(roundTransition?.champion);

    fadeOutTransitionMusic().then(() => {
      roundTransition = null;
      if (keepChampion) {
        // Keep champion bed; only clear match/stinger leftovers
        silenceMatchPlayers({ removeTransition: true });
      } else {
        disposeMedia({ removeTransition: true });
      }
      render();
    });
  }, fadeAt);
}

/**
 * Start champion bed, then ramp volume up so the reveal doesn't hard-cut in.
 */
function playChampionBedFaded(song, volume01) {
  if (!isSongLike(song)) return Promise.resolve(null);

  const target = volumeForTrack(song.id, volume01);

  if (isYouTubeTrack(song)) {
    return playChampionBed(song, target).then((p) => {
      const side = document.getElementById('yt-champion') ? 'champion' : 'champion-bed';
      setYouTubeVolume(side, 0);
      fadeYouTubeVolume(side, 0, target, FADE_IN_MS, 'yt-champion-in');
      return p;
    });
  }

  const audio = getChampionBed();
  const already = audio.dataset.trackId === song.id && audio.currentSrc && !audio.paused;
  if (already) {
    return playChampionBed(song, target);
  }

  return playChampionBed(song, target).then((el) => {
    if (el && typeof el.volume === 'number') {
      try {
        el.volume = 0;
      } catch {
      }
      fadeHtmlVolume(el, 0, target, FADE_IN_MS, 'html-champion-in');
    }
    return el;
  });
}

function silenceMatchPlayers({ removeTransition = false } = {}) {
  for (const side of ['a', 'b', 'champion', 'transition']) {
    const el = document.getElementById(`audio-${side}`);
    if (!el) continue;
    hardStopAudio(el);
    if (side === 'transition' && removeTransition && el.parentNode) {
      try {
        el.parentNode.removeChild(el);
      } catch {
      }
    }
  }
}

function render() {
  const keepTransition = Boolean(roundTransition);
  const keepChampionBed =
    Boolean(roundTransition?.champion) ||
    Boolean(state?.finished && isSongLike(state?.champion));

  if (keepChampionBed) {
    // Stop match/stinger players only — champion bed must keep playing straight through
    silenceMatchPlayers({ removeTransition: !keepTransition });
  } else {
    disposeMedia({ removeTransition: !keepTransition });
  }

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
    if (!isSongLike(state.champion)) {
      // Corrupt finished save — bail to setup rather than crash
      state = null;
      clearSavedProgress();
      clearStageVibe();
      renderSetup();
      return;
    }
    applyStageVibe(1);
    renderResults(gen);
    return;
  }

  if (state) {
    // Recover stuck mid-wave queues (empty matches / index past end)
    if (!Array.isArray(state.matches) || state.matchIndex >= state.matches.length) {
      state = null;
      clearSavedProgress();
      error = 'Saved progress looked stuck — start a new tournament.';
      clearStageVibe();
      renderSetup();
      return;
    }
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
            <label for="playlist-url">Playlist link</label>
            <input
              id="playlist-url"
              name="url"
              type="url"
              placeholder="Spotify or YouTube playlist URL…"
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
              : `<p class="setup-note">Public Spotify or YouTube playlist. YouTube needs a free API key on the server.</p>`
          }

          <div class="form-actions">
            <button type="submit" id="start-btn">Start tournament</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('setup-form')?.addEventListener('submit', onStart);
}

function renderRoundTransition() {
  const t = roundTransition;
  if (!t) return;
  const stage = stageFromRemaining(t.remaining);
  const isChampion = Boolean(t.champion);
  const label = t.toLabel || '';
  const redundantSub =
    /songs left$/i.test(label) ||
    /^\d+\s+songs$/i.test(label) ||
    label === `${t.remaining} songs left`;

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
      <p class="round-transition-to">${escapeHtml(label)}</p>
      ${
        redundantSub
          ? ''
          : `<p class="round-transition-sub">${t.remaining} songs left</p>`
      }
    </div>
  `;
}

function renderMatch(gen) {
  const match = currentMatch(state);
  if (!match || !isSongLike(match.a) || !isSongLike(match.b)) {
    state = null;
    clearSavedProgress();
    error = 'Could not restore that match — start a new tournament.';
    renderSetup();
    return;
  }

  const p = progress(state);
  const roundDone = Math.max(0, p.matchInRound - 1);
  const roundTotal = Math.max(1, p.matchesInRound);
  const pct = Math.min(100, Math.round((roundDone / roundTotal) * 100));
  const matchesLeft = Math.max(0, p.matchesInRound - roundDone);

  app.innerHTML = `
    ${brandHeaderHtml(state.playlist?.name || 'Playlist')}

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

  document.getElementById('pick-a')?.addEventListener('click', () => onPick('a'));
  document.getElementById('pick-b')?.addEventListener('click', () => onPick('b'));
  document.getElementById('quit-btn')?.addEventListener('click', onQuit);
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
  const vol = volumeForTrack(song.id, volumeBySide[side] ?? DEFAULT_MATCH_VOLUME);
  volumeBySide[side] = vol;
  const pct = Math.round(vol * 100);
  const nameSize = nameFontSize(song.name);
  const yt = isYouTubeTrack(song);
  const art = song.image
    ? `<img class="cover-art-img" src="${escapeHtml(song.image)}" alt="" />`
    : `<div class="cover-art-fallback" aria-hidden="true">${yt ? '▶' : '🎵'}</div>`;
  return `
    <article class="song-card${yt ? ' song-card-yt' : ''}" data-side="${side}" data-source="${yt ? 'youtube' : 'spotify'}">
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
        <p>${escapeHtml(song.artists)}${yt ? ' · YouTube' : ''}</p>
      </div>
      <div class="cover-player${yt ? ' cover-player-yt' : ''}" id="cover-player-${side}">
        ${
          yt
            ? `<div class="yt-mini" id="yt-mini-${side}">
                <div class="yt-host" id="yt-${side}"></div>
                <button
                  type="button"
                  class="cover-play-btn yt-play-overlay"
                  id="play-${side}"
                  aria-label="Play ${escapeHtml(song.name)}"
                  disabled
                >
                  <span class="cover-art">${art}</span>
                  <span class="cover-play-icon" id="play-icon-${side}" aria-hidden="true">▶</span>
                </button>
              </div>
              <div class="yt-seek-row">
                <span class="yt-time" id="yt-time-${side}">0:00</span>
                <input
                  type="range"
                  class="yt-seek"
                  id="yt-seek-${side}"
                  min="0"
                  max="1000"
                  step="1"
                  value="0"
                  aria-label="Seek in ${escapeHtml(song.name)}"
                  disabled
                />
                <span class="yt-time yt-time-end" id="yt-dur-${side}">0:00</span>
              </div>`
            : `<audio id="audio-${side}" preload="none"></audio>
        <button
          type="button"
          class="cover-play-btn"
          id="play-${side}"
          aria-label="Play ${escapeHtml(song.name)}"
          disabled
        >
          <span class="cover-art">${art}</span>
          <span class="cover-play-icon" id="play-icon-${side}" aria-hidden="true">▶</span>
        </button>`
        }
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

function trimPreviewCache() {
  const keys = Object.keys(previewCache);
  if (keys.length <= MAX_CACHED_PREVIEWS) return;
  for (const id of keys.slice(0, keys.length - MAX_CACHED_PREVIEWS)) {
    delete previewCache[id];
  }
}

async function ensurePreviewUrl(trackId) {
  if (!trackId) return null;
  if (previewCache[trackId]) return previewCache[trackId];
  if (previewInflight[trackId]) return previewInflight[trackId];

  previewInflight[trackId] = (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 400));
          }
          const res = await fetch(`/api/preview/${encodeURIComponent(trackId)}`);
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.previewUrl) {
            previewCache[trackId] = data.previewUrl;
            trimPreviewCache();
            return data.previewUrl;
          }
        } catch {
        }
      }
      return null;
    } finally {
      delete previewInflight[trackId];
    }
  })();

  return previewInflight[trackId];
}

function setSideVolume(side, volume01, trackId = null) {
  const vol = Math.min(1, Math.max(0, volume01));
  if (side === 'a' || side === 'b') volumeBySide[side] = vol;
  if (trackId) rememberTrackVolume(trackId, vol);
  const pct = Math.round(vol * 100);
  const label = document.getElementById(`vol-pct-${side}`);
  if (label) label.textContent = `${pct}%`;
  const audio = document.getElementById(`audio-${side}`);
  if (audio) audio.volume = vol;
  setYouTubeVolume(side, vol);
  if (side === 'champion' || side === 'a') {
    // champion UI may control bed
    setYouTubeVolume('champion-bed', vol);
  }
  saveProgress();
}

function setPlayingUi(side, playing) {
  const icon = document.getElementById(`play-icon-${side}`);
  const btn = document.getElementById(`play-${side}`);
  const cover = document.getElementById(`cover-player-${side}`);
  if (icon) icon.textContent = playing ? '❚❚' : '▶';
  if (btn) btn.classList.toggle('is-playing', playing);
  if (cover) cover.classList.toggle('is-yt-playing', Boolean(playing));
}

function stillCurrent(gen, el) {
  return gen === renderGeneration && el != null && el.isConnected;
}

function wireYouTubeSeekBar(side, gen) {
  const seek = document.getElementById(`yt-seek-${side}`);
  const timeEl = document.getElementById(`yt-time-${side}`);
  const durEl = document.getElementById(`yt-dur-${side}`);
  if (!seek) return () => {};

  let scrubbing = false;
  let pollId = 0;

  const update = () => {
    if (!stillCurrent(gen, seek)) return;
    const dur = getYouTubeDuration(side);
    const cur = getYouTubeCurrentTime(side);
    if (durEl && dur > 0) durEl.textContent = formatYouTubeTime(dur);
    if (timeEl) timeEl.textContent = formatYouTubeTime(cur);
    if (!scrubbing && dur > 0) {
      seek.value = String(Math.round((cur / dur) * 1000));
    }
    seek.disabled = dur <= 0;
  };

  const startPoll = () => {
    if (pollId) return;
    pollId = window.setInterval(() => {
      if (!stillCurrent(gen, seek)) {
        stopPoll();
        return;
      }
      update();
    }, 250);
  };

  const stopPoll = () => {
    if (pollId) {
      clearInterval(pollId);
      pollId = 0;
    }
  };

  seek.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  seek.addEventListener('pointerup', () => {
    scrubbing = false;
  });
  seek.addEventListener('input', () => {
    if (!stillCurrent(gen, seek)) return;
    scrubbing = true;
    const dur = getYouTubeDuration(side);
    if (dur <= 0) return;
    const frac = Number(seek.value) / 1000;
    if (timeEl) timeEl.textContent = formatYouTubeTime(frac * dur);
  });
  seek.addEventListener('change', () => {
    if (!stillCurrent(gen, seek)) return;
    const frac = Number(seek.value) / 1000;
    seekYouTube(side, frac);
    scrubbing = false;
    update();
  });

  // Keep polling whenever this side exists (cheap); updates times while paused too
  startPoll();
  update();

  return () => stopPoll();
}

function wireYouTubeOnePlayer(side, song, volumeKey, gen, options = {}) {
  const { autoplay = false } = options;
  const playBtn = document.getElementById(`play-${side}`);
  const status = document.getElementById(`status-${side}`);
  const slider = document.getElementById(`vol-${side}`);
  const host = document.getElementById(`yt-${side}`);
  const vid = youtubeVideoId(song);
  if (!playBtn || !host || !vid) return;

  const initialVol = volumeForTrack(
    song.id,
    side === 'champion'
      ? DEFAULT_TRANSITION_VOLUME
      : volumeBySide[volumeKey] ?? DEFAULT_MATCH_VOLUME
  );
  if (side === 'a' || side === 'b') volumeBySide[volumeKey] = initialVol;
  if (slider) {
    slider.value = String(Math.round(initialVol * 100));
    const label = document.getElementById(`vol-pct-${side}`);
    if (label) label.textContent = `${Math.round(initialVol * 100)}%`;
  }

  if (slider) {
    slider.addEventListener('input', () => {
      if (!stillCurrent(gen, slider)) return;
      const vol = Number(slider.value) / 100;
      if (side === 'a' || side === 'b') volumeBySide[volumeKey] = vol;
      rememberTrackVolume(song.id, vol);
      setYouTubeVolume(side, vol);
      if (side === 'champion') setYouTubeVolume('champion-bed', vol);
      const label = document.getElementById(`vol-pct-${side}`);
      if (label) label.textContent = `${slider.value}%`;
      saveProgress();
    });
  }

  const stopSeekPoll = wireYouTubeSeekBar(side, gen);

  playBtn.disabled = true;
  if (status) {
    status.hidden = false;
    status.textContent = 'Loading YouTube…';
  }

  loadYouTubeApi()
    .then(() => {
      if (!stillCurrent(gen, playBtn)) return null;
      return mountYouTubePlayer(side, vid, {
        volume01: initialVol,
        autoplay: false,
        onPlaying: () => {
          if (!stillCurrent(gen, playBtn)) return;
          setPlayingUi(side, true);
        },
        onPaused: () => {
          if (!stillCurrent(gen, playBtn)) return;
          setPlayingUi(side, false);
        },
        onEnded: () => {
          if (!stillCurrent(gen, playBtn)) return;
          setPlayingUi(side, false);
          const seek = document.getElementById(`yt-seek-${side}`);
          if (seek) seek.value = '0';
        },
      });
    })
    .then((player) => {
      if (!stillCurrent(gen, playBtn)) {
        stopSeekPoll();
        return;
      }
      playBtn.disabled = false;
      if (!player) {
        playBtn.classList.add('no-preview');
        if (status) {
          status.hidden = false;
          status.textContent = 'Could not load YouTube player';
        }
        return;
      }
      if (status) status.hidden = true;
      setYouTubeVolume(side, initialVol);

      playBtn.onclick = async () => {
        if (!stillCurrent(gen, playBtn)) return;
        if (youtubeIsPlaying(side)) {
          pauseYouTube(side);
          setPlayingUi(side, false);
          return;
        }
        pauseAllHtmlAudioExcept(side);
        pauseAllYouTubeExcept(side);
        setYouTubeVolume(side, volumeForTrack(song.id, initialVol));
        await playYouTube(side);
        if (stillCurrent(gen, playBtn)) setPlayingUi(side, true);
      };

      if (autoplay) {
        pauseAllHtmlAudioExcept(side);
        pauseAllYouTubeExcept(side);
        playYouTube(side).then(() => {
          if (stillCurrent(gen, playBtn)) setPlayingUi(side, true);
        });
      }
    })
    .catch(() => {
      stopSeekPoll();
      if (!stillCurrent(gen, playBtn)) return;
      playBtn.disabled = false;
      playBtn.classList.add('no-preview');
      if (status) {
        status.hidden = false;
        status.textContent = 'Could not load YouTube';
      }
    });
}

function wireOnePlayer(side, song, volumeKey, gen, options = {}) {
  const { autoplay = false } = options;
  if (!isSongLike(song)) return;

  if (isYouTubeTrack(song)) {
    wireYouTubeOnePlayer(side, song, volumeKey, gen, options);
    return;
  }

  const audio = document.getElementById(`audio-${side}`);
  const playBtn = document.getElementById(`play-${side}`);
  const status = document.getElementById(`status-${side}`);
  const slider = document.getElementById(`vol-${side}`);
  if (!audio || !playBtn) return;

  const initialVol = volumeForTrack(
    song.id,
    side === 'champion'
      ? DEFAULT_TRANSITION_VOLUME
      : volumeBySide[volumeKey] ?? DEFAULT_MATCH_VOLUME
  );
  if (side === 'a' || side === 'b') volumeBySide[volumeKey] = initialVol;
  audio.volume = initialVol;
  if (slider) {
    slider.value = String(Math.round(initialVol * 100));
    const label = document.getElementById(`vol-pct-${side}`);
    if (label) label.textContent = `${Math.round(initialVol * 100)}%`;
  }

  if (slider) {
    slider.addEventListener('input', () => {
      if (!stillCurrent(gen, slider)) return;
      const vol = Number(slider.value) / 100;
      if (side === 'champion') {
        rememberTrackVolume(song.id, vol);
        audio.volume = vol;
        const label = document.getElementById('vol-pct-champion');
        if (label) label.textContent = `${slider.value}%`;
        saveProgress();
      } else {
        setSideVolume(volumeKey, vol, song.id);
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
        delete previewInflight[song.id];
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
    setupPreviewPlayback(side, song, volumeKey, gen, audio, playBtn, status, url, {
      autoplay,
    });
  });
}

function setupPreviewPlayback(side, song, volumeKey, gen, audio, playBtn, status, url, options = {}) {
  const { autoplay = false } = options;
  // crossOrigin before src → real analyser samples; graph routes to speakers
  prepareMediaElement(audio);
  audio.src = url;
  connectMediaElement(audio);
  playBtn.disabled = false;
  playBtn.classList.remove('no-preview');

  const pauseOthers = () => {
    pauseAllHtmlAudioExcept(side);
    pauseAllYouTubeExcept(side);
  };

  const startPlay = async () => {
    if (!stillCurrent(gen, playBtn) || !stillCurrent(gen, audio)) return;
    pauseOthers();
    try {
      audio.volume = volumeForTrack(
        song.id,
        side === 'champion'
          ? Number(document.getElementById('vol-champion')?.value || 10) / 100
          : volumeBySide[volumeKey] ?? DEFAULT_MATCH_VOLUME
      );
      rememberTrackVolume(song.id, audio.volume);
      connectMediaElement(audio);
      await resumeAudioContext();
      kickScopeFromPlayback();
      await audio.play();
      if (!stillCurrent(gen, playBtn)) {
        audio.pause();
        return;
      }
      setPlayingUi(side, true);
      kickScopeFromPlayback();
    } catch {
      if (stillCurrent(gen, status) && status) {
        status.hidden = false;
        status.textContent = 'Could not play preview';
      }
    }
  };

  playBtn.onclick = async () => {
    if (!stillCurrent(gen, playBtn) || !stillCurrent(gen, audio)) return;

    if (!audio.paused) {
      audio.pause();
      setPlayingUi(side, false);
      return;
    }

    await startPlay();
  };

  audio.onended = () => {
    if (!stillCurrent(gen, audio)) return;
    setPlayingUi(side, false);
  };

  let corsRetryDone = false;
  audio.onerror = () => {
    if (!stillCurrent(gen, audio)) return;
    // One retry without CORS so sound still works if CDN blocks anonymous
    if (!corsRetryDone && audio.crossOrigin) {
      corsRetryDone = true;
      try {
        audio.removeAttribute('crossorigin');
        audio.src = url;
        connectMediaElement(audio);
        return;
      } catch {
      }
    }
    setPlayingUi(side, false);
    if (stillCurrent(gen, status) && status) {
      status.hidden = false;
      status.textContent = 'Could not play preview';
    }
  };

  if (autoplay) {
    startPlay();
  }
}

function wireSongPlayers(songA, songB, gen) {
  wireOnePlayer('a', songA, 'a', gen);
  wireOnePlayer('b', songB, 'b', gen);
}

function wireChampionBedUi(champion, gen) {
  const playBtn = document.getElementById('play-champion');
  const status = document.getElementById('status-champion');
  const slider = document.getElementById('vol-champion');
  if (!playBtn || !isSongLike(champion)) return;

  const yt = isYouTubeTrack(champion);
  const audio = yt ? null : getChampionBed();
  const vol =
    !yt && championBedIsFor(champion.id) && audio
      ? audio.volume
      : volumeForTrack(champion.id, DEFAULT_TRANSITION_VOLUME);
  if (audio) audio.volume = vol;

  if (slider) {
    slider.value = String(Math.round(vol * 100));
    const label = document.getElementById('vol-pct-champion');
    if (label) label.textContent = `${Math.round(vol * 100)}%`;
    slider.addEventListener('input', () => {
      if (!stillCurrent(gen, slider)) return;
      const v = Number(slider.value) / 100;
      if (audio) audio.volume = v;
      setYouTubeVolume('champion-bed', v);
      rememberTrackVolume(champion.id, v);
      const label = document.getElementById('vol-pct-champion');
      if (label) label.textContent = `${slider.value}%`;
      saveProgress();
    });
  }

  const ytSide = () =>
    document.getElementById('yt-champion') ? 'champion' : 'champion-bed';

  const syncUi = () => {
    if (!stillCurrent(gen, playBtn)) return;
    if (yt) setPlayingUi('champion', youtubeIsPlaying(ytSide()));
    else if (audio) setPlayingUi('champion', !audio.paused && !audio.ended);
  };

  const alreadyGoing = yt
    ? youtubeIsPlaying('champion') || youtubeIsPlaying('champion-bed')
    : championBedIsPlaying(champion.id);

  if (alreadyGoing) {
    playBtn.disabled = false;
    playBtn.classList.remove('no-preview');
    if (status) status.hidden = true;
    setPlayingUi('champion', true);
  } else {
    playBtn.disabled = true;
    if (status) {
      status.hidden = false;
      status.textContent = yt ? 'Loading YouTube…' : 'Loading preview…';
    }
    playChampionBed(champion, vol).then((el) => {
      if (!stillCurrent(gen, playBtn)) return;
      if (!el) {
        playBtn.disabled = false;
        playBtn.classList.add('no-preview');
        if (status) {
          status.hidden = false;
          status.textContent = yt ? 'Could not play YouTube' : 'No preview available';
        }
        return;
      }
      playBtn.disabled = false;
      playBtn.classList.remove('no-preview');
      if (status) status.hidden = true;
      syncUi();
    });
  }

  playBtn.onclick = async () => {
    if (!stillCurrent(gen, playBtn)) return;
    if (yt) {
      const ytSide = document.getElementById('yt-champion') ? 'champion' : 'champion-bed';
      if (youtubeIsPlaying(ytSide)) {
        pauseYouTube(ytSide);
        setPlayingUi('champion', false);
        return;
      }
      pauseAllHtmlAudioExcept(null);
      pauseAllYouTubeExcept(ytSide);
      setYouTubeVolume(ytSide, volumeForTrack(champion.id, vol));
      await playYouTube(ytSide);
      if (stillCurrent(gen, playBtn)) setPlayingUi('champion', true);
      return;
    }

    if (audio && !audio.paused) {
      audio.pause();
      setPlayingUi('champion', false);
      return;
    }
    pauseAllHtmlAudioExcept(null);
    pauseAllYouTubeExcept(null);
    try {
      if (championBedIsFor(champion.id) && audio) {
        await audio.play();
      } else {
        await playChampionBed(champion, audio?.volume ?? vol);
      }
      kickScopeFromPlayback();
      if (!stillCurrent(gen, playBtn)) return;
      setPlayingUi('champion', true);
    } catch {
      if (stillCurrent(gen, status) && status) {
        status.hidden = false;
        status.textContent = 'Could not play preview';
      }
    }
  };

  if (audio) {
    audio.onplay = syncUi;
    audio.onpause = syncUi;
  }
}

function renderResults(gen) {
  const playlist = state.playlist || {};
  const champion = state.champion;
  const history = Array.isArray(state.history) ? state.history : [];
  const initialCount = state.initialCount || history.length + 1;
  const bracketHtml = buildBracketHtml(history, champion);
  const bed = document.getElementById('audio-champion-bed');
  const champVolPct = Math.round(
    (championBedIsFor(champion.id) && bed
      ? bed.volume
      : volumeForTrack(champion.id, DEFAULT_TRANSITION_VOLUME)) * 100
  );

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
        <h2>${escapeHtml(playlist.name || 'Playlist')}</h2>
        <p class="small muted">${initialCount} songs · ${history.length} matchups</p>
      </div>

      <div class="champion-block">
        <p class="label">Winner</p>
        <h3>${escapeHtml(champion.name)}</h3>
        <p class="artists">${escapeHtml(champion.artists || '')}</p>
        <div class="card-action-slot volume-control champion-volume">
          <span class="volume-icon" aria-hidden="true">🔊</span>
          <input
            type="range"
            class="volume-slider"
            id="vol-champion"
            min="0"
            max="100"
            step="1"
            value="${champVolPct}"
            aria-label="Volume for champion"
          />
          <span class="volume-pct" id="vol-pct-champion">${champVolPct}%</span>
        </div>
        <div class="cover-player champion-cover${isYouTubeTrack(champion) ? ' cover-player-yt' : ''}" id="cover-player-champion">
          ${
            isYouTubeTrack(champion)
              ? `<div class="yt-mini" id="yt-mini-champion">
                  <div class="yt-host" id="yt-champion"></div>
                  <button
                    type="button"
                    class="cover-play-btn yt-play-overlay${
                      youtubeIsPlaying('champion') || youtubeIsPlaying('champion-bed')
                        ? ' is-playing'
                        : ''
                    }"
                    id="play-champion"
                    aria-label="Play or pause ${escapeHtml(champion.name)}"
                  >
                    <span class="cover-art">
                      ${
                        champion.image
                          ? `<img class="cover-art-img" src="${escapeHtml(champion.image)}" alt="" />`
                          : `<div class="cover-art-fallback" aria-hidden="true">▶</div>`
                      }
                    </span>
                    <span class="cover-play-icon" id="play-icon-champion" aria-hidden="true">${
                      youtubeIsPlaying('champion') || youtubeIsPlaying('champion-bed')
                        ? '❚❚'
                        : '▶'
                    }</span>
                  </button>
                </div>
                <div class="yt-seek-row">
                  <span class="yt-time" id="yt-time-champion">0:00</span>
                  <input
                    type="range"
                    class="yt-seek"
                    id="yt-seek-champion"
                    min="0"
                    max="1000"
                    step="1"
                    value="0"
                    aria-label="Seek in champion"
                    disabled
                  />
                  <span class="yt-time yt-time-end" id="yt-dur-champion">0:00</span>
                </div>`
              : `<audio id="audio-champion" preload="none"></audio>
          <button
            type="button"
            class="cover-play-btn${championBedIsPlaying(champion.id) ? ' is-playing' : ''}"
            id="play-champion"
            aria-label="Play or pause ${escapeHtml(champion.name)}"
          >
            <span class="cover-art">
              ${
                champion.image
                  ? `<img class="cover-art-img" src="${escapeHtml(champion.image)}" alt="" />`
                  : `<div class="cover-art-fallback" aria-hidden="true">🎵</div>`
              }
            </span>
            <span class="cover-play-icon" id="play-icon-champion" aria-hidden="true">${
              championBedIsPlaying(champion.id) ? '❚❚' : '▶'
            }</span>
          </button>`
          }
          <p class="preview-status small muted" id="status-champion" hidden></p>
        </div>
      </div>

      <div class="results-actions">
        <button type="button" id="new-game-btn">Start new game!</button>
      </div>

      <section class="bracket-section" id="bracket-section">
        <h3>Tournament bracket</h3>
        ${bracketHtml}
      </section>
    </div>
  `;

  document.getElementById('new-game-btn')?.addEventListener('click', onQuit);
  // Bind UI only — never restart the bed if reveal already started it
  wireChampionBedUi(champion, gen);
  if (isYouTubeTrack(champion)) {
    // Seek bar follows whichever host is active (inline champion preferred)
    wireYouTubeSeekBar(
      document.getElementById('yt-champion') ? 'champion' : 'champion-bed',
      gen
    );
  }
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
  if (!isSongLike(song)) {
    return `<div class="mm-cover mm-${escapeHtml(role)}"><div class="mm-cover-inner"><span class="mm-fallback" aria-hidden="true">🎵</span></div></div>`;
  }
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
  if (!m?.a || !m?.b) return '';
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

async function onStart(e) {
  e.preventDefault();
  error = '';
  const form = e.target;
  const url = form.url?.value?.trim?.() || '';
  const seeding = form.seeding?.value === 'shuffle' ? 'shuffle' : 'order';
  if (!url) {
    error = 'Paste a public Spotify or YouTube playlist link.';
    render();
    return;
  }

  loadGeneration += 1;
  const myLoad = loadGeneration;

  clearTransitionTimer();
  roundTransition = null;
  disposeMedia({ removeTransition: true });
  stopChampionBed();
  clearPreviewCache();
  state = null;
  playlistTracks = [];
  transitionSongIndex = 0;
  clearTrackVolumes();

  loading = true;
  render();

  try {
    const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Failed to load playlist (${res.status})`);
    }
    if (myLoad !== loadGeneration) return;

    const tracks = Array.isArray(data.tracks) ? data.tracks.filter(isSongLike) : [];
    if (tracks.length < 2) {
      throw new Error('Need at least 2 playable songs in the playlist to run a tournament.');
    }

    playlistTracks = tracks;
    transitionSongIndex = 0;
    clearTrackVolumes();
    state = createTournament(data, tracks, seeding);
    // Warm YouTube API early when needed
    if (data.source === 'youtube' || tracks.some(isYouTubeTrack)) {
      loadYouTubeApi().catch(() => {});
    }
    saveProgress({ immediate: true });
  } catch (err) {
    if (myLoad !== loadGeneration) return;
    error = err.message || 'Could not start tournament.';
    state = null;
    playlistTracks = [];
    transitionSongIndex = 0;
    clearTrackVolumes();
    clearSavedProgress();
  } finally {
    if (myLoad !== loadGeneration) return;
    loading = false;
    render();
  }
}

function onPick(side) {
  if (!state || roundTransition || state.finished) return;
  if (side !== 'a' && side !== 'b') return;
  if (!currentMatch(state)) return;

  const fromLabel = progress(state).roundLabel;
  const prevRound = state.roundNumber;
  const prevRegion = currentMatch(state)?.region;

  state = pickWinner(state, side);
  saveProgress({ immediate: true });

  if (state.finished) {
    scheduleTransition(
      {
        fromLabel,
        toLabel: 'Champion',
        remaining: 1,
        champion: state.champion,
      },
      6200
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
        transitionSong: takeNextTransitionSong(),
      },
      4200
    );
    return;
  }

  render();
}

function onQuit() {
  loadGeneration += 1;
  clearTransitionTimer();
  roundTransition = null;
  disposeMedia({ removeTransition: true });
  stopChampionBed();
  destroyAllYouTubePlayers();
  clearPreviewCache();
  clearSavedProgress();
  state = null;
  playlistTracks = [];
  transitionSongIndex = 0;
  clearTrackVolumes();
  error = '';
  clearStageVibe();
  render();
}

function goHome() {
  onQuit();
}

app.addEventListener('click', (e) => {
  if (!e.target.closest('[data-home]')) return;
  e.preventDefault();
  goHome();
});

// Flush debounced saves and stop audio when leaving the tab/page
window.addEventListener('pagehide', () => {
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveProgressNow();
  }
  disposeMedia({ removeTransition: true });
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
    saveProgressNow();
  }
});

const restored = loadProgress();
if (restored) {
  state = restored;
  roundTransition = null;
}

// Idle baseline wave; becomes a real scope when a preview plays
startScope();
render();
