import './style.css';
import {
  createTournament,
  pickWinner,
  currentMatch,
  progress,
  shuffle,
} from './tournament.js';
import {
  prepareMediaElement,
  connectMediaElement,
  disconnectMediaElement,
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
import { startPartyApp, parseRoomFromUrl } from './party/party-app.js';
import {
  ensurePreviewUrl,
  clearPreviewCache,
  dropEliminatedPreviews,
  dropPreview,
  prefetchMatchPreviews,
  prefetchSongPreview,
} from './preview-cache.js';

const app = document.querySelector('#app');

let state = null;
let loading = false;
let error = '';
let roundTransition = null;
let transitionTimer = null;
let saveTimer = null;

/**
 * Solo pre-tournament roster (after load playlist / add songs).
 * @type {null | {
 *   meta: object,
 *   tracks: object[],
 *   selected: Set<string>,
 *   seeding: 'order'|'shuffle',
 *   loadUrl: string,
 *   addUrl: string,
 *   busy: string,
 *   note: string,
 * }}
 */
let setupDraft = null;
/** Remember last paste on “Different playlist” so the load form isn’t empty. */
let lastSetupUrl = '';

/** home = mode pick · solo = bracket · rating = rate 0–10 · party = multiplayer WS */
let uiMode = 'home';
/**
 * When on setup screens under solo/rating, which game starts after the roster.
 * @type {'bracket'|'rating'}
 */
let setupGameMode = 'bracket';
/**
 * Active Rating Mode session (song-by-song 0–10 scores).
 * @type {null | {
 *   meta: object,
 *   entries: { song: object, rating: number|null }[],
 *   index: number,
 *   finished: boolean,
 *   draft: number,
 * }}
 */
let ratingSession = null;
/** @type {{ destroy: () => void } | null} */
let partyHandle = null;

/**
 * Snapshots of tournament state before each pick (for Undo).
 * Stored as serialized plain objects (same shape as localStorage saves).
 */
const undoStack = [];
const MAX_UNDO = 80;

/** In-flight champion bed load so we never double-set src (which restarts audio). */
let championBedLoad = null; // { id, promise }

/** Active volume fades (key → rAF id). */
const fadeRafs = new Map();
const FADE_IN_MS = 550;
const FADE_OUT_MS = 500;

let volumeBySide = { a: 0.25, b: 0.25 };

/** Last volume the user set for each track id (0–1). */
const volumeByTrackId = Object.create(null);

let renderGeneration = 0;
let loadGeneration = 0;

/** Original playlist order for transition music (1st, 2nd, 3rd…). */
let playlistTracks = [];
let transitionSongIndex = 0;

const DEFAULT_MATCH_VOLUME = 0.25;
const DEFAULT_TRANSITION_VOLUME = 0.1;
const SAVE_DEBOUNCE_MS = 350;
const MAX_TRACK_VOLUMES = 200;

const STORAGE_KEY = 'playlist-bracket-save-v1';
/** Solo only: skip per-match “song won” full-screen beat (long playlists). */
const SOLO_SKIP_WIN_BEAT_KEY = 'playlist-bracket-skip-win-beat-v1';
const WIN_BEAT_MS = 4200;

function loadSkipWinBeatPref() {
  try {
    return localStorage.getItem(SOLO_SKIP_WIN_BEAT_KEY) === '1';
  } catch {
    return false;
  }
}

function saveSkipWinBeatPref(on) {
  try {
    localStorage.setItem(SOLO_SKIP_WIN_BEAT_KEY, on ? '1' : '0');
  } catch {
  }
}

/** @type {boolean} solo setting — when true, go straight to next match after pick */
let skipWinBeat = loadSkipWinBeatPref();

/**
 * Solo-only full-screen “this song won the match” beat (like party).
 * Separate from roundTransition so disposeMedia / round logic can’t skip it.
 * @type {{ song: object, after: null | { type: 'wave', payload: object } | { type: 'done' } } | null}
 */
let matchWinBeat = null;

/**
 * Match <audio> players live outside #app and are reused every round.
 * Creating a new MediaElementSource per match was the long-tournament lag bug
 * (100+ songs × 2 previews left hundreds of Web Audio nodes alive).
 */
const POOL_AUDIO_SIDES = new Set(['a', 'b', 'transition', 'champion-bed']);

/** Match audio currently fading out — don't hard-stop until fade finishes. */
const fadingAudio = new Set();

/** Cleanup fns for YouTube seek-bar intervals (cleared every render). */
const seekPollCleanups = [];

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

/**
 * Drop preview URL cache entries for songs that already lost.
 * Keeps memory flat during 100+ song brackets.
 */
function prunePreviewCache() {
  if (!state) {
    clearPreviewCache();
    return;
  }
  const keep = new Set();
  const m = currentMatch(state);
  if (m?.a?.id) keep.add(m.a.id);
  if (m?.b?.id) keep.add(m.b.id);
  if (state.champion?.id) keep.add(state.champion.id);
  dropEliminatedPreviews(eliminatedTrackIds(state), keep);
}

/**
 * Reusable <audio> for match sides / transition / champion bed.
 * Lives on document.body so re-rendering #app never destroys it.
 */
function getPoolAudio(side, { loop = false, preload = 'none' } = {}) {
  const id = `audio-${side}`;
  let audio = document.getElementById(id);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = id;
    audio.setAttribute('playsinline', '');
    audio.preload = preload;
    audio.hidden = true;
    if (loop) audio.loop = true;
    document.body.appendChild(audio);
  }
  return audio;
}

function clearAllSeekPolls() {
  for (const stop of seekPollCleanups) {
    try {
      stop();
    } catch {
    }
  }
  seekPollCleanups.length = 0;
}

/**
 * Stop playback and free the decoded buffer on this element.
 * Pool players keep their MediaElementSource (reconnect is impossible once
 * created). Abandoned one-off elements disconnect from the Web Audio graph.
 */
function hardStopAudio(audio, { abandon = false } = {}) {
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
    try {
      delete audio.dataset.trackId;
    } catch {
    }
    // Empty source + load aborts network and frees the decoded buffer
    audio.load();
  } catch {
  }
  if (abandon) {
    disconnectMediaElement(audio);
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
 * Fade match audio to silence without hard-stopping yet.
 * Pool players stay put on <body>; disposeMedia skips them while fading so the
 * soft handoff into the round-transition screen still works.
 */
function orphanAndFadeOutMatchAudio() {
  const jobs = [];
  for (const side of ['a', 'b']) {
    const el = document.getElementById(`audio-${side}`);
    if (el && !el.paused && el.currentSrc) {
      const from = el.volume;
      fadingAudio.add(el);
      const fadeKey = `fade-match-${side}`;
      jobs.push(
        fadeHtmlVolume(el, from, 0, FADE_OUT_MS, fadeKey).then(() => {
          hardStopAudio(el);
          fadingAudio.delete(el);
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
    fadingAudio.add(audio);
    jobs.push(
      fadeHtmlVolume(audio, from, 0, FADE_OUT_MS, 'html-transition-out').then(() => {
        hardStopAudio(audio);
        fadingAudio.delete(audio);
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
  clearAllSeekPolls();

  for (const side of ['a', 'b', 'champion', 'transition']) {
    const audio = document.getElementById(`audio-${side}`);
    if (audio && !fadingAudio.has(audio)) {
      // Pool players: stop + clear buffer, keep the element + MediaElementSource
      hardStopAudio(audio, { abandon: !POOL_AUDIO_SIDES.has(side) });
      if (
        side === 'transition' &&
        removeTransition &&
        audio.parentNode &&
        !POOL_AUDIO_SIDES.has(side)
      ) {
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
  destroyYouTubePlayer('rating');

  // Legacy one-off fade clones (pre-pool) — disconnect and remove
  for (const el of document.querySelectorAll('audio[id^="fade-match-"]')) {
    if (fadingAudio.has(el)) continue;
    hardStopAudio(el, { abandon: true });
    try {
      el.remove();
    } catch {
    }
  }

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
  return getPoolAudio('champion-bed', { loop: true, preload: 'auto' });
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
  // Keep MediaElementSource on the pool player — only clear the buffer
  hardStopAudio(audio);
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

/** Songs that lost a match are out of the bracket. */
function eliminatedTrackIds(s = state) {
  const out = new Set();
  if (!s?.history) return out;
  for (const m of s.history) {
    if (m?.loserId) out.add(m.loserId);
  }
  return out;
}

function isTrackStillInBracket(song, s = state) {
  if (!isSongLike(song) || !s) return false;
  if (s.finished) return s.champion?.id === song.id;
  return !eliminatedTrackIds(s).has(song.id);
}

/**
 * Next transition stinger: walk the original playlist in order, but only pick
 * songs still alive in the bracket (skip anyone who already lost).
 */
function takeNextTransitionSong() {
  if (!playlistTracks.length || !state) return null;

  const eliminated = eliminatedTrackIds(state);
  const n = playlistTracks.length;

  for (let i = 0; i < n; i++) {
    const idx = (transitionSongIndex + i) % n;
    const song = playlistTracks[idx];
    if (!isSongLike(song)) continue;
    if (eliminated.has(song.id)) continue;

    // Resume search after this pick next time (same sequential priority)
    transitionSongIndex = idx + 1;
    saveProgress({ immediate: true });
    return song;
  }

  // Nobody left alive (shouldn't happen mid-tournament)
  return null;
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
    const audio = getPoolAudio('transition', { preload: 'auto' });
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

/**
 * Solo: show winning song full-screen (party-style), then next match or wave transition.
 */
function scheduleMatchWinBeat(winnerSong, after) {
  clearTransitionTimer();
  cancelFade('html-transition-in');
  cancelFade('html-transition-out');
  cancelFade('yt-transition-in');
  cancelFade('yt-transition-out');
  cancelAllFades();

  orphanAndFadeOutMatchAudio();
  roundTransition = null;
  matchWinBeat = {
    song: winnerSong,
    after: after || null,
  };

  // Force a clean paint of the win screen (don't rely on roundTransition path)
  renderGeneration += 1;
  const gen = renderGeneration;
  document.body.classList.remove('on-setup');
  applyStageVibe(state?.remaining ?? 0);
  renderMatchWinBeat();

  // Play the winner’s preview under the art
  if (isSongLike(winnerSong)) {
    playAutoPreview(
      winnerSong,
      volumeForTrack(winnerSong.id, DEFAULT_TRANSITION_VOLUME),
      gen
    );
  }

  // Free time: resolve next match (and optional wave stinger) while celebration plays
  const nextMatch = currentMatch(state);
  if (nextMatch) prefetchMatchPreviews(nextMatch);
  if (after?.type === 'wave' && after.payload?.transitionSong) {
    prefetchSongPreview(after.payload.transitionSong);
  }

  const ms = WIN_BEAT_MS;
  const fadeLead = Math.min(FADE_OUT_MS, Math.max(0, ms - 80));
  const fadeAt = Math.max(0, ms - fadeLead);

  transitionTimer = setTimeout(() => {
    transitionTimer = null;
    const next = matchWinBeat?.after || null;
    matchWinBeat = null;

    fadeOutTransitionMusic().then(() => {
      disposeMedia({ removeTransition: true });
      if (next?.type === 'wave' && next.payload) {
        scheduleTransition(next.payload, next.ms || 4200);
      } else {
        render();
      }
    });
  }, fadeAt);
}

function renderMatchWinBeat() {
  const w = matchWinBeat?.song;
  if (!isSongLike(w)) {
    matchWinBeat = null;
    render();
    return;
  }
  const stage = stageFromRemaining(state?.remaining ?? 0);
  const art = w.image
    ? `<img class="solo-win-art" src="${escapeHtml(w.image)}" alt="" />`
    : `<div class="solo-win-art solo-win-art-fallback" aria-hidden="true">🎵</div>`;
  app.innerHTML = `
    ${soloWinTransitionToggleHtml()}
    <div class="solo-win-beat party-winner-full stage-${escapeHtml(stage)}" role="status" aria-live="polite">
      <div class="party-winner-full-inner solo-win-beat-inner">
        <p class="solo-win-kicker party-winner-label">Winner</p>
        <div class="solo-win-art-stage party-win-art-stage">${art}</div>
        <h1 class="solo-win-title party-winner-title">${escapeHtml(w.name || '')}</h1>
        <p class="solo-win-artists party-winner-artists">${escapeHtml(w.artists || '')}</p>
      </div>
    </div>
  `;
  wireSoloWinTransitionToggle();
}

function scheduleTransition(payload, ms) {
  clearTransitionTimer();
  cancelFade('html-transition-in');
  cancelFade('html-transition-out');
  cancelFade('yt-transition-in');
  cancelFade('yt-transition-out');
  matchWinBeat = null;

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
  clearAllSeekPolls();
  for (const side of ['a', 'b', 'champion', 'transition']) {
    const el = document.getElementById(`audio-${side}`);
    if (!el || fadingAudio.has(el)) continue;
    hardStopAudio(el, { abandon: !POOL_AUDIO_SIDES.has(side) });
    if (
      side === 'transition' &&
      removeTransition &&
      el.parentNode &&
      !POOL_AUDIO_SIDES.has(side)
    ) {
      try {
        el.parentNode.removeChild(el);
      } catch {
      }
    }
  }
  onMediaDisposed();
}

function enterSolo() {
  if (partyHandle) {
    try {
      partyHandle.destroy();
    } catch {
    }
    partyHandle = null;
  }
  clearRatingSession();
  setupGameMode = 'bracket';
  uiMode = 'solo';
  error = '';
  render();
}

function enterRating() {
  if (partyHandle) {
    try {
      partyHandle.destroy();
    } catch {
    }
    partyHandle = null;
  }
  // Leave any in-progress bracket behind
  clearTransitionTimer();
  roundTransition = null;
  matchWinBeat = null;
  state = null;
  disposeMedia({ removeTransition: true });
  stopChampionBed();
  clearRatingSession();
  clearSetupDraft();
  setupGameMode = 'rating';
  uiMode = 'rating';
  error = '';
  render();
}

function enterParty() {
  // Party owns #app — stop solo media first
  clearTransitionTimer();
  roundTransition = null;
  matchWinBeat = null;
  clearRatingSession();
  disposeMedia({ removeTransition: true });
  stopChampionBed();
  clearStageVibe();
  if (partyHandle) {
    try {
      partyHandle.destroy();
    } catch {
    }
  }
  uiMode = 'party';
  partyHandle = startPartyApp(app, {
    onExit: () => {
      try {
        partyHandle?.destroy();
      } catch {
      }
      partyHandle = null;
      uiMode = 'home';
      document.body.classList.add('on-setup');
      render();
    },
  });
}

function clearRatingSession() {
  ratingSession = null;
}

function renderHome() {
  document.body.classList.add('on-setup');
  app.innerHTML = `
    <div class="setup-page">
      <div class="setup-bg" aria-hidden="true">
        <span class="blob blob-a"></span>
        <span class="blob blob-b"></span>
        <span class="swirl swirl-a"></span>
        <span class="swirl swirl-b"></span>
      </div>
      ${brandHeaderHtml('Song tournament')}
      <div class="card setup-card home-card">
        <div class="home-actions">
          <button type="button" id="mode-solo" class="home-mode-btn">
            <strong>Solo</strong>
            <span>1v1 bracket · pick winners</span>
          </button>
          <button type="button" id="mode-rating" class="home-mode-btn home-mode-rating">
            <strong>Rating Mode</strong>
            <span>Rate each song 0–10 · ranked list at the end</span>
          </button>
          <button type="button" id="mode-party" class="home-mode-btn home-mode-party">
            <strong>Play with friends</strong>
            <span>Host a room · share a code · vote together</span>
          </button>
        </div>
      </div>
    </div>
  `;
  document.getElementById('mode-solo')?.addEventListener('click', enterSolo);
  document.getElementById('mode-rating')?.addEventListener('click', enterRating);
  document.getElementById('mode-party')?.addEventListener('click', enterParty);
}

function render() {
  // Party mode draws itself; don't wipe #app
  if (uiMode === 'party') return;

  // Rating mode owns its own screens (don't run tournament dispose logic over them)
  if (uiMode === 'rating' && ratingSession) {
    document.body.classList.remove('on-setup');
    renderGeneration += 1;
    const gen = renderGeneration;
    if (ratingSession.finished) {
      disposeMedia({ removeTransition: true });
      applyStageVibe(1);
      renderRatingResults(gen);
    } else {
      applyStageVibe(
        Math.max(2, (ratingSession.entries?.length || 0) - (ratingSession.index || 0))
      );
      renderRatingSong(gen);
    }
    return;
  }

  // Solo match-win beat owns the screen — don't run normal dispose (kills the beat audio)
  if (matchWinBeat && isSongLike(matchWinBeat.song)) {
    document.body.classList.remove('on-setup');
    applyStageVibe(state?.remaining ?? 0);
    renderMatchWinBeat();
    return;
  }

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

  // Drop preview URLs for songs that already lost so long brackets stay light
  prunePreviewCache();

  renderGeneration += 1;
  const gen = renderGeneration;
  document.body.classList.remove('on-setup');

  if (loading && !setupDraft) {
    clearStageVibe();
    app.innerHTML = `
      ${brandHeaderHtml()}
      <div class="card loading"><div class="spinner"></div> Loading playlist…</div>
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
      uiMode = 'solo';
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
      uiMode = 'solo';
      renderSetup();
      return;
    }
    uiMode = 'solo';
    applyStageVibe(state.remaining);
    renderMatch(gen);
    return;
  }

  clearStageVibe();
  if (uiMode === 'solo' || uiMode === 'rating') {
    renderSetup();
    return;
  }
  renderHome();
}

function setupBgHtml() {
  return `
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
  `;
}

function clearSetupDraft() {
  setupDraft = null;
}

function selectedCount(draft = setupDraft) {
  if (!draft?.selected) return 0;
  return draft.selected.size;
}

function renderSetup() {
  document.body.classList.add('on-setup');
  if (setupDraft && Array.isArray(setupDraft.tracks) && setupDraft.tracks.length > 0) {
    renderSetupRoster();
    return;
  }
  renderSetupLoad();
}

function renderSetupLoad() {
  app.innerHTML = `
    <div class="setup-page">
      ${setupBgHtml()}
      ${brandHeaderHtml()}

      <div class="card setup-card">
        <form class="setup-form" id="setup-load-form">
          <div class="field">
            <label for="playlist-url">Playlist or song link</label>
            <input
              id="playlist-url"
              name="url"
              type="url"
              placeholder="Spotify / YouTube playlist, or Spotify song…"
              required
              autocomplete="off"
              value="${escapeHtml(lastSetupUrl || '')}"
            />
          </div>

          ${
            error
              ? `<div class="error-box" role="alert">${escapeHtml(error)}</div>`
              : `<p class="setup-note">Load a Spotify or YouTube playlist, then add more songs or playlists from either service.</p>`
          }

          <div class="form-actions">
            <button type="submit" id="load-playlist-btn" ${loading ? 'disabled' : ''}>
              ${loading ? 'Loading…' : 'Load songs'}
            </button>
            <button type="button" class="ghost" id="solo-back-home">Back to menu</button>
          </div>
        </form>
      </div>
    </div>
  `;

  document.getElementById('setup-load-form')?.addEventListener('submit', onLoadPlaylist);
  document.getElementById('solo-back-home')?.addEventListener('click', () => {
    clearSetupDraft();
    clearRatingSession();
    error = '';
    uiMode = 'home';
    render();
  });
}

function renderSetupRoster() {
  const draft = setupDraft;
  if (!draft) return renderSetupLoad();

  const total = draft.tracks.length;
  const included = selectedCount(draft);
  const busy = Boolean(draft.busy);
  const metaName = draft.meta?.name || 'Your songs';
  const metaImg = draft.meta?.image
    ? `<img class="roster-meta-art" src="${escapeHtml(draft.meta.image)}" alt="" />`
    : `<div class="roster-meta-art roster-meta-art-fallback" aria-hidden="true">🎵</div>`;

  const rows = draft.tracks
    .map((song, idx) => {
      const on = draft.selected.has(song.id);
      const art = song.image
        ? `<img class="roster-row-art" src="${escapeHtml(song.image)}" alt="" loading="lazy" />`
        : `<span class="roster-row-art roster-row-art-fallback" aria-hidden="true">♪</span>`;
      return `
        <label class="roster-row ${on ? 'is-on' : 'is-off'}" data-track-id="${escapeHtml(song.id)}">
          <input
            type="checkbox"
            class="roster-check"
            data-track-id="${escapeHtml(song.id)}"
            ${on ? 'checked' : ''}
            ${busy ? 'disabled' : ''}
          />
          <span class="roster-check-ui" aria-hidden="true"></span>
          ${art}
          <span class="roster-row-text">
            <span class="roster-row-name">${escapeHtml(song.name || 'Unknown')}</span>
            <span class="roster-row-artists">${escapeHtml(song.artists || '')}</span>
          </span>
          <span class="roster-row-idx muted small">${idx + 1}</span>
        </label>
      `;
    })
    .join('');

  app.innerHTML = `
    <div class="setup-page setup-page-roster">
      ${setupBgHtml()}
      ${brandHeaderHtml()}

      <div class="card setup-card setup-card-roster">
        <header class="roster-header">
          ${metaImg}
          <div class="roster-header-text">
            <h2 class="roster-title">${escapeHtml(metaName)}</h2>
            <p class="roster-sub muted small">
              <strong id="roster-count">${included}</strong> of ${total} ${
                setupGameMode === 'rating' ? 'to rate' : 'in the bracket'
              }
              ${
                draft.meta?.owner
                  ? ` · ${escapeHtml(String(draft.meta.owner))}`
                  : ''
              }
            </p>
          </div>
        </header>

        <div class="roster-toolbar">
          <button type="button" class="ghost small-btn" id="roster-all" ${busy ? 'disabled' : ''}>Select all</button>
          <button type="button" class="ghost small-btn" id="roster-none" ${busy ? 'disabled' : ''}>Select none</button>
          <button type="button" class="ghost small-btn" id="roster-reload" ${busy ? 'disabled' : ''}>Different playlist</button>
        </div>

        <div class="roster-list" id="roster-list" role="list">${rows}</div>

        <div class="field roster-add-field">
          <label for="add-song-url">Add songs or playlist by link</label>
          <div class="roster-add-row">
            <input
              id="add-song-url"
              type="url"
              placeholder="Spotify / YouTube song or playlist…"
              autocomplete="off"
              value="${escapeHtml(draft.addUrl || '')}"
              ${busy ? 'disabled' : ''}
            />
            <button type="button" id="add-song-btn" ${busy ? 'disabled' : ''}>
              ${draft.busy === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>

        <div class="field">
          <label>${setupGameMode === 'rating' ? 'Listen order' : 'Matchup order'}</label>
          <div class="seed-options">
            <div class="seed-option">
              <input type="radio" name="seeding" id="seed-order" value="order" ${
                draft.seeding !== 'shuffle' ? 'checked' : ''
              } ${busy ? 'disabled' : ''} />
              <label for="seed-order">
                Playlist order
                <span>${
                  setupGameMode === 'rating'
                    ? 'Rate in list order'
                    : '1st vs 2nd, 3rd vs 4th…'
                }</span>
              </label>
            </div>
            <div class="seed-option">
              <input type="radio" name="seeding" id="seed-shuffle" value="shuffle" ${
                draft.seeding === 'shuffle' ? 'checked' : ''
              } ${busy ? 'disabled' : ''} />
              <label for="seed-shuffle">
                Shuffle
                <span>${
                  setupGameMode === 'rating' ? 'Random order' : 'Random matchups'
                }</span>
              </label>
            </div>
          </div>
        </div>

        ${
          error
            ? `<div class="error-box" role="alert">${escapeHtml(error)}</div>`
            : draft.note
              ? `<p class="setup-note roster-note">${escapeHtml(draft.note)}</p>`
              : ''
        }

        <div class="form-actions">
          <button type="button" id="start-btn" ${
            busy || included < (setupGameMode === 'rating' ? 1 : 2) ? 'disabled' : ''
          }>
            ${
              busy && draft.busy === 'start'
                ? 'Starting…'
                : setupGameMode === 'rating'
                  ? `Start rating (${included})`
                  : `Start tournament (${included})`
            }
          </button>
          <button type="button" class="ghost" id="solo-back-home" ${busy ? 'disabled' : ''}>Back to menu</button>
        </div>
      </div>
    </div>
  `;

  wireSetupRoster();
}

function updateRosterCountUi() {
  const el = document.getElementById('roster-count');
  if (el && setupDraft) el.textContent = String(selectedCount());
  const start = document.getElementById('start-btn');
  if (start && setupDraft) {
    const n = selectedCount();
    const min = setupGameMode === 'rating' ? 1 : 2;
    start.disabled = Boolean(setupDraft.busy) || n < min;
    start.textContent =
      setupDraft.busy === 'start'
        ? 'Starting…'
        : setupGameMode === 'rating'
          ? `Start rating (${n})`
          : `Start tournament (${n})`;
  }
}

function wireSetupRoster() {
  const list = document.getElementById('roster-list');
  list?.addEventListener('change', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !t.classList.contains('roster-check')) return;
    if (!setupDraft) return;
    const id = t.getAttribute('data-track-id');
    if (!id) return;
    if (t.checked) setupDraft.selected.add(id);
    else setupDraft.selected.delete(id);
    const row = t.closest('.roster-row');
    if (row) {
      row.classList.toggle('is-on', t.checked);
      row.classList.toggle('is-off', !t.checked);
    }
    error = '';
    updateRosterCountUi();
  });

  document.getElementById('roster-all')?.addEventListener('click', () => {
    if (!setupDraft) return;
    for (const s of setupDraft.tracks) setupDraft.selected.add(s.id);
    render();
  });
  document.getElementById('roster-none')?.addEventListener('click', () => {
    if (!setupDraft) return;
    setupDraft.selected.clear();
    render();
  });
  document.getElementById('roster-reload')?.addEventListener('click', () => {
    lastSetupUrl = setupDraft?.loadUrl || lastSetupUrl;
    clearSetupDraft();
    error = '';
    render();
  });

  document.querySelectorAll('input[name="seeding"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (!setupDraft) return;
      setupDraft.seeding = el.value === 'shuffle' ? 'shuffle' : 'order';
    });
  });

  const addInput = document.getElementById('add-song-url');
  addInput?.addEventListener('input', () => {
    if (setupDraft) setupDraft.addUrl = addInput.value;
  });
  addInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onAddSongToDraft();
    }
  });
  document.getElementById('add-song-btn')?.addEventListener('click', () => onAddSongToDraft());
  document.getElementById('start-btn')?.addEventListener('click', () => onStartFromDraft());
  document.getElementById('solo-back-home')?.addEventListener('click', () => {
    clearSetupDraft();
    clearRatingSession();
    error = '';
    uiMode = 'home';
    render();
  });
}

/**
 * Load playlist (or first song) into the roster editor — does not start the tournament yet.
 */
async function onLoadPlaylist(e) {
  e.preventDefault();
  error = '';
  const form = e.target;
  const url = form.url?.value?.trim?.() || '';
  if (!url) {
    error = 'Paste a public Spotify or YouTube playlist link (or a Spotify song).';
    render();
    return;
  }

  loadGeneration += 1;
  const myLoad = loadGeneration;
  loading = true;
  render();

  try {
    const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Failed to load (${res.status})`);
    }
    if (myLoad !== loadGeneration) return;

    const tracks = Array.isArray(data.tracks) ? data.tracks.filter(isSongLike) : [];
    if (tracks.length < 1) {
      throw new Error('No playable songs found.');
    }

    // Dedupe by id while keeping order
    const seen = new Set();
    const unique = [];
    for (const t of tracks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      unique.push(t);
    }

    const selected = new Set(unique.map((t) => t.id));
    lastSetupUrl = url;
    setupDraft = {
      meta: {
        id: data.id || 'custom',
        name: data.name || 'Playlist',
        description: data.description || '',
        image: data.image || unique[0]?.image || null,
        owner: data.owner || '',
        spotifyUrl: data.spotifyUrl || null,
        source: data.source || 'spotify',
      },
      tracks: unique,
      selected,
      seeding: 'order',
      loadUrl: url,
      addUrl: '',
      busy: '',
      note:
        unique.length === 1
          ? 'One song loaded — add more with links below, or load a playlist.'
          : `Loaded ${unique.length} songs.`,
    };
    error = '';
  } catch (err) {
    if (myLoad !== loadGeneration) return;
    error = err.message || 'Could not load playlist.';
    clearSetupDraft();
  } finally {
    if (myLoad !== loadGeneration) return;
    loading = false;
    render();
  }
}

function songFromImport(data) {
  if (!isSongLike(data)) return null;
  return {
    id: data.id,
    name: data.name,
    artists: data.artists || '',
    image: data.image || null,
    source: data.source || 'spotify',
    spotifyUrl: data.spotifyUrl || null,
    youtubeUrl: data.youtubeUrl || null,
    youtubeId: data.youtubeId || null,
    embedUrl: data.embedUrl || null,
  };
}

function refreshDraftSourceLabel() {
  if (!setupDraft?.tracks?.length) return;
  const sources = new Set(setupDraft.tracks.map((t) => t.source || 'spotify'));
  const mixed = sources.size > 1;
  if (setupDraft.meta) {
    setupDraft.meta.source = mixed ? 'mixed' : [...sources][0];
    if (mixed && setupDraft.meta.name && !/mix|custom/i.test(setupDraft.meta.name)) {
      // Keep original name; source flag is enough
    }
  }
}

async function onAddSongToDraft() {
  if (!setupDraft || setupDraft.busy) return;
  error = '';
  const input = document.getElementById('add-song-url');
  const url = (input?.value || setupDraft.addUrl || '').trim();
  if (!url) {
    error = 'Paste a Spotify or YouTube song or playlist link.';
    render();
    return;
  }

  setupDraft.busy = 'add';
  setupDraft.addUrl = url;
  setupDraft.note = '';
  render();

  try {
    const res = await fetch(`/api/import?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Could not add (${res.status})`);
    }
    const incoming = (Array.isArray(data.tracks) ? data.tracks : [])
      .map(songFromImport)
      .filter(Boolean);
    if (!incoming.length) {
      throw new Error('That link did not return any playable songs.');
    }

    let added = 0;
    let reselected = 0;
    for (const song of incoming) {
      const existing = setupDraft.tracks.find((t) => t.id === song.id);
      if (existing) {
        if (!setupDraft.selected.has(song.id)) {
          setupDraft.selected.add(song.id);
          reselected += 1;
        }
        continue;
      }
      setupDraft.tracks.push(song);
      setupDraft.selected.add(song.id);
      added += 1;
    }

    refreshDraftSourceLabel();
    setupDraft.addUrl = '';
    if (data.kind === 'playlist') {
      setupDraft.note =
        added > 0
          ? `Added ${added} from “${data.name || 'playlist'}”${
              reselected ? ` · ${reselected} already listed` : ''
            }.`
          : reselected
            ? `Those songs were already in the list (${reselected} selected).`
            : 'Nothing new to add from that playlist.';
    } else {
      const one = incoming[0];
      setupDraft.note =
        added > 0
          ? `Added “${one.name}”.`
          : `"${one.name}" is already in the list (kept selected).`;
    }
    requestAnimationFrame(() => {
      const list = document.getElementById('roster-list');
      if (list) list.scrollTop = list.scrollHeight;
    });
  } catch (err) {
    error = err.message || 'Could not add that link.';
  } finally {
    if (setupDraft) setupDraft.busy = '';
    render();
  }
}

/**
 * Start bracket tournament or Rating Mode from the curated roster.
 */
function onStartFromDraft() {
  if (!setupDraft || setupDraft.busy) return;
  error = '';

  const seedingEl = document.querySelector('input[name="seeding"]:checked');
  const seeding =
    seedingEl?.value === 'shuffle' || setupDraft.seeding === 'shuffle'
      ? 'shuffle'
      : 'order';
  setupDraft.seeding = seeding;

  let tracks = setupDraft.tracks.filter(
    (t) => setupDraft.selected.has(t.id) && isSongLike(t)
  );
  const isRating = setupGameMode === 'rating' || uiMode === 'rating';
  const minSongs = isRating ? 1 : 2;
  if (tracks.length < minSongs) {
    error = isRating
      ? 'Pick at least 1 song to rate.'
      : 'Pick at least 2 songs for the tournament.';
    render();
    return;
  }

  loadGeneration += 1;
  clearTransitionTimer();
  roundTransition = null;
  matchWinBeat = null;
  fadingAudio.clear();
  disposeMedia({ removeTransition: true });
  stopChampionBed();
  clearPreviewCache();
  clearUndoStack();
  clearTrackVolumes();
  transitionSongIndex = 0;
  state = null;

  const meta = {
    id: setupDraft.meta?.id || 'custom',
    name: setupDraft.meta?.name || (isRating ? 'Rating session' : 'Custom bracket'),
    description: setupDraft.meta?.description || '',
    image: setupDraft.meta?.image || tracks[0]?.image || null,
    owner: setupDraft.meta?.owner || '',
    spotifyUrl: setupDraft.meta?.spotifyUrl || null,
    source: setupDraft.meta?.source || tracks[0]?.source || 'spotify',
    tracks,
  };

  try {
    if (seeding === 'shuffle') {
      tracks = shuffle(tracks);
    }
    playlistTracks = tracks;

    if (isRating) {
      ratingSession = {
        meta,
        entries: tracks.map((song) => ({ song, rating: null })),
        index: 0,
        finished: false,
        draft: 5.0,
      };
      uiMode = 'rating';
      if (meta.source === 'youtube' || tracks.some(isYouTubeTrack)) {
        loadYouTubeApi().catch(() => {});
      }
      clearSetupDraft();
      error = '';
    } else {
      clearRatingSession();
      // tracks may already be shuffled above; pass 'order' so createTournament keeps that list
      state = createTournament(meta, tracks, 'order');
      uiMode = 'solo';
      if (meta.source === 'youtube' || tracks.some(isYouTubeTrack)) {
        loadYouTubeApi().catch(() => {});
      }
      saveProgress({ immediate: true });
      clearSetupDraft();
      error = '';
    }
  } catch (err) {
    error = err.message || 'Could not start.';
    state = null;
    clearRatingSession();
    playlistTracks = [];
  }
  render();
}

// ─── Rating Mode ─────────────────────────────────────────────────────────────

function clampRating(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(10, Math.max(0, Math.round(x * 10) / 10));
}

function formatRating(n) {
  const v = clampRating(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

function ratingDraftValue() {
  if (!ratingSession) return 5;
  if (ratingSession.draft != null && Number.isFinite(ratingSession.draft)) {
    return clampRating(ratingSession.draft);
  }
  const cur = ratingSession.entries[ratingSession.index];
  if (cur?.rating != null) return clampRating(cur.rating);
  return 5;
}

function setRatingDraft(n) {
  if (!ratingSession || ratingSession.finished) return;
  ratingSession.draft = clampRating(n);
  const big = document.getElementById('rating-big');
  if (big) big.textContent = formatRating(ratingSession.draft);
  const slider = document.getElementById('rating-slider');
  if (slider) slider.value = String(ratingSession.draft);
  document.querySelectorAll('[data-rating-btn]').forEach((btn) => {
    const v = Number(btn.getAttribute('data-rating-btn'));
    btn.classList.toggle('is-active', Math.floor(ratingSession.draft) === v);
  });
}

/**
 * One song at a time: art, play, 0–10 buttons + 0.1 slider.
 */
function renderRatingSong(gen) {
  const session = ratingSession;
  if (!session || session.finished) return;

  const total = session.entries.length;
  const idx = Math.min(session.index, total - 1);
  session.index = idx;
  const entry = session.entries[idx];
  const song = entry?.song;
  if (!isSongLike(song)) {
    error = 'This rating session is broken — start again.';
    clearRatingSession();
    uiMode = 'rating';
    render();
    return;
  }

  // Prefer existing rating when revisiting; else keep draft
  if (entry.rating != null && Number.isFinite(entry.rating)) {
    session.draft = clampRating(entry.rating);
  } else if (session.draft == null || !Number.isFinite(session.draft)) {
    session.draft = 5.0;
  } else {
    session.draft = clampRating(session.draft);
  }

  const draft = session.draft;
  const art = song.image
    ? `<img class="rating-art" src="${escapeHtml(song.image)}" alt="" />`
    : `<div class="rating-art rating-art-fallback" aria-hidden="true">🎵</div>`;
  const yt = isYouTubeTrack(song);
  const buttons = Array.from({ length: 11 }, (_, i) => {
    const active = Math.floor(draft) === i ? ' is-active' : '';
    return `<button type="button" class="rating-num-btn${active}" data-rating-btn="${i}">${i}</button>`;
  }).join('');

  const isLast = idx >= total - 1;
  const progressPct = total ? Math.round((idx / total) * 100) : 0;

  app.innerHTML = `
    <div class="rating-page">
      ${brandHeaderHtml('Rating Mode')}
      <div class="rating-progress-bar" aria-hidden="true">
        <span style="width:${progressPct}%"></span>
      </div>
      <p class="rating-progress-label muted small">${idx + 1} / ${total}</p>

      <article class="card rating-card">
        <div class="rating-cover ${yt ? 'is-yt' : ''}" id="rating-cover">
          ${art}
          ${
            yt
              ? `<div id="yt-rating" class="rating-yt-host"></div>`
              : ''
          }
          <button type="button" class="rating-play" id="rating-play" title="Play / pause">
            <span id="rating-play-icon">▶</span>
          </button>
        </div>
        <h2 class="rating-title">${escapeHtml(song.name || 'Unknown')}</h2>
        <p class="rating-artists muted">${escapeHtml(song.artists || '')}</p>

        <div class="rating-score-block">
          <p class="rating-big" id="rating-big">${formatRating(draft)}</p>
          <p class="muted small">Your rating</p>
        </div>

        <div class="rating-num-row" role="group" aria-label="Rating 0 to 10">
          ${buttons}
        </div>

        <div class="rating-fine">
          <button type="button" class="ghost small-btn" id="rating-minus" title="−0.1">−0.1</button>
          <input
            type="range"
            id="rating-slider"
            min="0"
            max="10"
            step="0.1"
            value="${draft}"
            aria-label="Fine rating"
          />
          <button type="button" class="ghost small-btn" id="rating-plus" title="+0.1">+0.1</button>
        </div>

        <div class="rating-actions form-actions">
          <button type="button" class="ghost" id="rating-back" ${idx === 0 ? 'disabled' : ''}>
            Back
          </button>
          <button type="button" id="rating-next">
            ${isLast ? 'Finish' : 'Next song'}
          </button>
        </div>
        <button type="button" class="ghost small-btn rating-quit" id="rating-quit">Quit to menu</button>
      </article>
    </div>
  `;

  wireRatingSong(gen, song, yt);
}

function wireRatingSong(gen, song, yt) {
  document.querySelectorAll('[data-rating-btn]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const whole = Number(btn.getAttribute('data-rating-btn'));
      // Keep decimal part if user already refined, only when landing on same integer
      const cur = ratingDraftValue();
      const next =
        Math.floor(cur) === whole && cur % 1 !== 0 ? cur : whole;
      setRatingDraft(next);
    });
  });

  const slider = document.getElementById('rating-slider');
  slider?.addEventListener('input', () => {
    setRatingDraft(Number(slider.value));
  });

  document.getElementById('rating-minus')?.addEventListener('click', () => {
    setRatingDraft(ratingDraftValue() - 0.1);
  });
  document.getElementById('rating-plus')?.addEventListener('click', () => {
    setRatingDraft(ratingDraftValue() + 0.1);
  });

  document.getElementById('rating-back')?.addEventListener('click', () => {
    if (!ratingSession || ratingSession.index <= 0) return;
    // save current draft onto current song before leaving
    const cur = ratingSession.entries[ratingSession.index];
    if (cur) cur.rating = ratingDraftValue();
    disposeMedia({ removeTransition: true });
    ratingSession.index -= 1;
    const prev = ratingSession.entries[ratingSession.index];
    ratingSession.draft =
      prev?.rating != null ? clampRating(prev.rating) : 5.0;
    render();
  });

  document.getElementById('rating-next')?.addEventListener('click', () => {
    if (!ratingSession) return;
    const cur = ratingSession.entries[ratingSession.index];
    if (cur) cur.rating = ratingDraftValue();
    disposeMedia({ removeTransition: true });
    if (ratingSession.index >= ratingSession.entries.length - 1) {
      ratingSession.finished = true;
      ratingSession.index = ratingSession.entries.length;
    } else {
      ratingSession.index += 1;
      const next = ratingSession.entries[ratingSession.index];
      ratingSession.draft =
        next?.rating != null ? clampRating(next.rating) : 5.0;
    }
    render();
  });

  document.getElementById('rating-quit')?.addEventListener('click', () => {
    disposeMedia({ removeTransition: true });
    clearRatingSession();
    clearSetupDraft();
    error = '';
    uiMode = 'home';
    render();
  });

  // Play controls
  const playBtn = document.getElementById('rating-play');
  const playIcon = document.getElementById('rating-play-icon');
  if (!playBtn) return;

  if (yt) {
    const vid = youtubeVideoId(song);
    playBtn.addEventListener('click', async () => {
      if (!stillCurrent(gen, playBtn) || !vid) return;
      if (youtubeIsPlaying('rating')) {
        pauseYouTube('rating');
        if (playIcon) playIcon.textContent = '▶';
        return;
      }
      try {
        pauseAllYouTubeExcept('rating');
        const audio = document.getElementById('audio-a');
        if (audio) hardStopAudio(audio);
        await mountYouTubePlayer('rating', vid, {
          volume01: volumeBySide.a ?? DEFAULT_MATCH_VOLUME,
          autoplay: true,
          onPlaying: () => {
            if (playIcon) playIcon.textContent = '❚❚';
            kickScopeFromPlayback();
          },
          onPaused: () => {
            if (playIcon) playIcon.textContent = '▶';
          },
        });
        setYouTubeVolume('rating', volumeBySide.a ?? DEFAULT_MATCH_VOLUME);
      } catch {
        if (playIcon) playIcon.textContent = '▶';
      }
    });
    // Autoplay once when card appears
    mountYouTubePlayer('rating', vid, {
      volume01: volumeBySide.a ?? DEFAULT_MATCH_VOLUME,
      autoplay: true,
      onPlaying: () => {
        if (playIcon && playIcon.isConnected) playIcon.textContent = '❚❚';
        kickScopeFromPlayback();
      },
    }).catch(() => {});
    return;
  }

  // Spotify HTML audio via pool player side "a"
  const audio = getPoolAudio('a');
  ensurePreviewUrl(song.id).then((url) => {
    if (!stillCurrent(gen, playBtn) || !url) return;
    hardStopAudio(audio);
    prepareMediaElement(audio);
    audio.src = url;
    try {
      audio.dataset.trackId = song.id;
    } catch {
    }
    connectMediaElement(audio);
    audio.volume = volumeBySide.a ?? DEFAULT_MATCH_VOLUME;

    const start = async () => {
      try {
        pauseAllYouTubeExcept(null);
        await resumeAudioContext();
        kickScopeFromPlayback();
        await audio.play();
        if (playIcon) playIcon.textContent = '❚❚';
      } catch {
        if (playIcon) playIcon.textContent = '▶';
      }
    };

    playBtn.onclick = async () => {
      if (!stillCurrent(gen, playBtn)) return;
      if (!audio.paused) {
        audio.pause();
        if (playIcon) playIcon.textContent = '▶';
        return;
      }
      await start();
    };
    start();
  });
}

/**
 * End screen: all songs sorted by rating (high → low), art with score overlay.
 */
function renderRatingResults(gen) {
  const session = ratingSession;
  if (!session) return;

  const ranked = session.entries
    .map((e, i) => ({
      song: e.song,
      rating: e.rating != null ? clampRating(e.rating) : 0,
      order: i,
    }))
    .filter((e) => isSongLike(e.song))
    .sort((a, b) => {
      if (b.rating !== a.rating) return b.rating - a.rating;
      return a.order - b.order;
    });

  const name = session.meta?.name || 'Your ratings';
  const cards = ranked
    .map((e, rank) => {
      const art = e.song.image
        ? `<img src="${escapeHtml(e.song.image)}" alt="" loading="lazy" />`
        : `<div class="rating-result-fallback" aria-hidden="true">🎵</div>`;
      return `
        <article class="rating-result-card" style="--rank-delay:${Math.min(rank, 20) * 40}ms">
          <div class="rating-result-art">
            ${art}
            <span class="rating-result-badge">${formatRating(e.rating)}</span>
            <span class="rating-result-rank">#${rank + 1}</span>
          </div>
          <div class="rating-result-meta">
            <strong class="rating-result-name">${escapeHtml(e.song.name || '')}</strong>
            <span class="rating-result-artists muted small">${escapeHtml(
              e.song.artists || ''
            )}</span>
          </div>
        </article>
      `;
    })
    .join('');

  const avg =
    ranked.length > 0
      ? ranked.reduce((s, e) => s + e.rating, 0) / ranked.length
      : 0;

  app.innerHTML = `
    <div class="rating-page rating-results-page">
      ${brandHeaderHtml('Rating Mode')}
      <header class="rating-results-header card">
        <h2>${escapeHtml(name)}</h2>
        <p class="muted small">
          ${ranked.length} song${ranked.length === 1 ? '' : 's'} · average
          <strong>${formatRating(avg)}</strong>
        </p>
      </header>
      <div class="rating-results-grid" id="rating-results-grid">
        ${cards || '<p class="muted">No ratings.</p>'}
      </div>
      <div class="form-actions rating-results-actions">
        <button type="button" id="rating-again">Rate again</button>
        <button type="button" class="ghost" id="rating-home">Back to menu</button>
      </div>
    </div>
  `;

  document.getElementById('rating-again')?.addEventListener('click', () => {
    disposeMedia({ removeTransition: true });
    // Restart same list, clear ratings
    if (ratingSession) {
      ratingSession.entries = ratingSession.entries.map((e) => ({
        song: e.song,
        rating: null,
      }));
      ratingSession.index = 0;
      ratingSession.finished = false;
      ratingSession.draft = 5.0;
    }
    render();
  });
  document.getElementById('rating-home')?.addEventListener('click', () => {
    disposeMedia({ removeTransition: true });
    clearRatingSession();
    clearSetupDraft();
    error = '';
    uiMode = 'home';
    render();
  });

  void gen;
}

/** Top-left toggle during solo play — skip full-screen win beat between matches. */
function soloWinTransitionToggleHtml() {
  skipWinBeat = loadSkipWinBeatPref();
  return `
    <label class="solo-win-toggle" title="Turn off full-screen winner between matches (faster for long playlists)">
      <input type="checkbox" id="skip-win-beat" ${skipWinBeat ? 'checked' : ''} />
      <span>Skip win transitions</span>
    </label>
  `;
}

function wireSoloWinTransitionToggle() {
  document.getElementById('skip-win-beat')?.addEventListener('change', (e) => {
    skipWinBeat = Boolean(e.target.checked);
    saveSkipWinBeatPref(skipWinBeat);
    // Blur so focus doesn't stay on the checkbox — otherwise 1/2/R keys are ignored
    // (onMatchKeydown skips events while an INPUT is focused).
    try {
      e.target.blur();
    } catch {
    }
  });
}

function renderRoundTransition() {
  const t = roundTransition;
  if (!t) return;
  const stage = stageFromRemaining(t.remaining ?? state?.remaining ?? 0);
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
    ${soloWinTransitionToggleHtml()}
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

    <div class="match-actions">
      <button type="button" class="ghost" id="undo-btn" ${
        undoStack.length ? '' : 'disabled'
      } title="Undo last pick (U)">
        ← Undo <kbd class="key-hint">U</kbd>
      </button>
      <button type="button" class="ghost match-action-random" id="random-btn" title="Pick a winner at random (R)">
        Can't decide · random <kbd class="key-hint">R</kbd>
      </button>
    </div>

    <p class="match-keys-hint muted small">
      Keyboard: <kbd class="key-hint">1</kbd> left song ·
      <kbd class="key-hint">2</kbd> right song ·
      <kbd class="key-hint">U</kbd> undo ·
      <kbd class="key-hint">R</kbd> random
    </p>

    <div class="match-toolbar">
      <button type="button" class="ghost" id="quit-btn">Start over</button>
      <span class="songs-left">${state.remaining} left in bracket</span>
    </div>
  `;

  wireSoloWinTransitionToggle();
  document.getElementById('pick-a')?.addEventListener('click', () => onPick('a'));
  document.getElementById('pick-b')?.addEventListener('click', () => onPick('b'));
  document.getElementById('undo-btn')?.addEventListener('click', () => onUndo());
  document.getElementById('random-btn')?.addEventListener('click', () => onRandomPick());
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
            : `<!-- match audio is a reused body pool player (see getPoolAudio) -->
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
        title="Pick ${escapeHtml(song.name)} (press ${side === 'a' ? '1' : '2'})"
        style="font-size:${nameSize}"
      >
        <span class="pick-key" aria-hidden="true">${side === 'a' ? '1' : '2'}</span>
        ${escapeHtml(song.name)}
      </button>
    </article>
  `;
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

  const stop = () => stopPoll();
  seekPollCleanups.push(stop);
  return stop;
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

  // Reuse the same <audio> for this side all tournament (Web Audio can only
  // attach one MediaElementSource per element — new elements = lag over time)
  const audio = getPoolAudio(side);
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
        dropPreview(song.id);
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
  // Stop any previous buffer on this pool player, then load the new preview URL
  hardStopAudio(audio);
  // crossOrigin before src → real analyser samples; graph routes to speakers
  prepareMediaElement(audio);
  audio.src = url;
  try {
    audio.dataset.trackId = song.id;
  } catch {
  }
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
              : `<!-- champion uses body pool player audio-champion-bed -->
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
        ${
          undoStack.length
            ? `<button type="button" class="ghost" id="undo-final-btn" title="Undo last pick (U)">
                ← Undo last pick <kbd class="key-hint">U</kbd>
              </button>`
            : ''
        }
        <button type="button" id="new-game-btn">Start new game!</button>
      </div>

      <section class="bracket-section" id="bracket-section">
        <h3>Tournament bracket</h3>
        ${bracketHtml}
      </section>
    </div>
  `;

  document.getElementById('new-game-btn')?.addEventListener('click', onQuit);
  document.getElementById('undo-final-btn')?.addEventListener('click', () => onUndo());
  wireBracketTabs(document.getElementById('bracket-explorer'));
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

/** Group history by tournament wave (roundNumber). Early waves first. */
function groupHistoryByRound(history) {
  const byRound = new Map();
  for (const m of history) {
    const key = m.round ?? 1;
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(m);
  }
  const keys = [...byRound.keys()].sort((a, b) => a - b);
  return keys.map((round) => ({
    round,
    matches: byRound.get(round),
  }));
}

/** Split history into left/right/cross/final columns for the classic map. */
function partitionBracketHistory(history) {
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

  return {
    leftByWave,
    rightByWave,
    crossByWave,
    finals,
    leftWaves: [...leftByWave.keys()].sort((a, b) => a - b),
    rightWaves: [...rightByWave.keys()].sort((a, b) => a - b),
  };
}

function waveLabelForParts(parts, wave, matches, initialCount) {
  const leftN = (parts.leftByWave.get(wave) || []).length;
  const rightN = (parts.rightByWave.get(wave) || []).length;
  const crossN = (parts.crossByWave.get(wave) || []).length;
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
  const allWaves = [...parts.leftWaves, ...parts.rightWaves];
  if (allWaves.length && wave === Math.min(...allWaves) && initialCount) {
    return `${initialCount} songs`;
  }
  if (approxSongs > 0) return `${approxSongs} songs left`;
  return mmRoundLabel(matches, initialCount);
}

function mmCenterHtml(parts, champion) {
  const finalMatch = parts.finals[parts.finals.length - 1];
  const crossCols = [...parts.crossByWave.keys()]
    .sort((a, b) => a - b)
    .map((w) => mmRoundColumn(parts.crossByWave.get(w), 'Play-in', 'mm-cross-round'))
    .join('');

  return `
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
}

function densityClass(parts) {
  const maxM = Math.max(
    1,
    ...[...parts.leftByWave.values(), ...parts.rightByWave.values()].map((x) => x.length),
    1
  );
  return maxM > 24 ? 'mm-dense' : maxM > 12 ? 'mm-mid' : 'mm-roomy';
}

/** Original dual-region March Madness map. */
function buildClassicBracketView(history, champion, initialCount) {
  const parts = partitionBracketHistory(history);
  const dens = densityClass(parts);
  const waveLabel = (w, matches) => waveLabelForParts(parts, w, matches, initialCount);

  const leftCols = parts.leftWaves
    .map((w) =>
      mmRoundColumn(parts.leftByWave.get(w), waveLabel(w, parts.leftByWave.get(w)), 'mm-side-left')
    )
    .join('');

  const rightCols = [...parts.rightWaves]
    .reverse()
    .map((w) =>
      mmRoundColumn(parts.rightByWave.get(w), waveLabel(w, parts.rightByWave.get(w)), 'mm-side-right')
    )
    .join('');

  return `
    <div class="mm-bracket-scroll">
      <div class="mm-bracket mm-classic ${dens}">
        <div class="mm-half mm-half-left">${leftCols}</div>
        ${mmCenterHtml(parts, champion)}
        <div class="mm-half mm-half-right">${rightCols}</div>
      </div>
    </div>
  `;
}

/**
 * Name a wave from how many songs played in it (2 × match count).
 * Finals / power-of-two fields get classic labels.
 */
function labelForRoundMatches(matches, initialCount) {
  if (!matches?.length) return 'Round';
  if (matches.some((m) => m.region === 'final')) return 'Final';
  if (matches.every((m) => m.region === 'cross')) return 'Play-in';

  const n = matches.length;
  const songs = n * 2;

  if (songs === 2) return 'Final';
  if (songs === 4) return 'Semifinals';
  if (songs === 8) return 'Quarterfinals';
  if (songs === 16) return 'Round of 16';
  if (songs === 32) return 'Round of 32';
  if (songs === 64) return 'Round of 64';
  if (songs === 128) return 'Round of 128';
  if (songs === 256) return 'Round of 256';

  // First wave of a non-power-of-two field
  if (initialCount && songs + 2 >= initialCount && songs <= initialCount) {
    return `${initialCount} songs`;
  }
  if (songs > 2) return `Round of ${songs}`;
  return `Wave ${matches[0].round}`;
}

/** Readable match cards for a single round only. */
function mmSingleRoundPanelHtml(matches, label) {
  if (!matches.length) {
    return '<p class="muted small">No matches in this round.</p>';
  }

  const items = matches
    .map((m) => {
      const aWin = m.winnerId === m.a.id;
      return `
        <div class="round-list-match round-list-match-lg">
          <div class="round-list-side ${aWin ? 'is-winner' : 'is-loser'}">
            ${mmCoverHtml(m.a, aWin ? 'winner' : 'loser')}
            <div class="round-list-text">
              <strong>${escapeHtml(m.a.name)}</strong>
              <span>${escapeHtml(m.a.artists || '')}</span>
            </div>
          </div>
          <span class="round-list-vs">vs</span>
          <div class="round-list-side ${aWin ? 'is-loser' : 'is-winner'}">
            ${mmCoverHtml(m.b, aWin ? 'loser' : 'winner')}
            <div class="round-list-text">
              <strong>${escapeHtml(m.b.name)}</strong>
              <span>${escapeHtml(m.b.artists || '')}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  return `
    <div class="round-list round-list-single">
      <h4 class="round-list-heading round-list-heading-solo">
        ${escapeHtml(label)}
        <span>${matches.length} match${matches.length === 1 ? '' : 'es'}</span>
      </h4>
      <div class="round-list-matches">${items}</div>
    </div>
  `;
}

function wireBracketTabs(root) {
  if (!root) return;
  const tabs = [...root.querySelectorAll('[data-bracket-tab]')];
  const panels = [...root.querySelectorAll('[data-bracket-panel]')];
  if (!tabs.length) return;

  const activate = (id) => {
    tabs.forEach((t) => {
      const on = t.getAttribute('data-bracket-tab') === id;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    panels.forEach((p) => {
      p.hidden = p.getAttribute('data-bracket-panel') !== id;
    });
  };

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => activate(tab.getAttribute('data-bracket-tab')));
  });
}

function buildBracketHtml(history, champion) {
  if (!history.length) {
    return '<p class="muted small">No matches recorded.</p>';
  }

  const initialCount = state?.initialCount || 0;
  const waves = groupHistoryByRound(history);
  // Earliest wave first (Round of 64 → … → Final), then classic map
  const roundTabs = waves.map((w) => ({
    id: `round-${w.round}`,
    label: labelForRoundMatches(w.matches, initialCount),
    matches: w.matches,
  }));

  const tabs = [
    ...roundTabs,
    { id: 'bracket-view', label: 'Bracket view', matches: null },
  ];

  const defaultTab = tabs[0]?.id || 'bracket-view';

  const tabBar = tabs
    .map(
      (t) => `
      <button
        type="button"
        class="bracket-tab${t.id === defaultTab ? ' is-active' : ''}"
        data-bracket-tab="${t.id}"
        role="tab"
        aria-selected="${t.id === defaultTab ? 'true' : 'false'}"
      >${escapeHtml(t.label)}</button>
    `
    )
    .join('');

  const roundPanels = roundTabs
    .map(
      (t) => `
      <div
        class="bracket-panel"
        data-bracket-panel="${t.id}"
        role="tabpanel"
        ${t.id === defaultTab ? '' : 'hidden'}
      >
        ${mmSingleRoundPanelHtml(t.matches, t.label)}
      </div>
    `
    )
    .join('');

  const classicPanel = `
    <div
      class="bracket-panel"
      data-bracket-panel="bracket-view"
      role="tabpanel"
      ${defaultTab === 'bracket-view' ? '' : 'hidden'}
    >
      <p class="bracket-hint muted small">Full dual-region bracket — scroll sideways if needed.</p>
      ${buildClassicBracketView(history, champion, initialCount)}
    </div>
  `;

  return `
    <div class="bracket-explorer" id="bracket-explorer">
      <div class="bracket-tabs" role="tablist" aria-label="Tournament rounds">${tabBar}</div>
      <div class="bracket-panels">${roundPanels}${classicPanel}</div>
    </div>
  `;
}

// Solo start path is onLoadPlaylist → roster → onStartFromDraft (see setupDraft).

/** Save a restore-point before changing the bracket (used by Undo). */
function pushUndoSnapshot() {
  if (!state) return;
  const snap = serializeState(state);
  if (!snap) return;
  undoStack.push(snap);
  while (undoStack.length > MAX_UNDO) undoStack.shift();
}

function clearUndoStack() {
  undoStack.length = 0;
}

/**
 * Random winner when the user can't decide.
 * Same path as clicking a pick button — still records history normally.
 */
function onRandomPick() {
  if (!state || roundTransition || matchWinBeat || state.finished) return;
  if (!currentMatch(state)) return;
  const side = Math.random() < 0.5 ? 'a' : 'b';
  onPick(side);
}

/**
 * Go back one pick. Works mid-match, during a round transition, and on the
 * champion screen (if there is something to undo).
 */
function onUndo() {
  if (!undoStack.length) return;

  // Cancel any in-progress "next round / champion" transition
  clearTransitionTimer();
  roundTransition = null;
  matchWinBeat = null;
  fadingAudio.clear();
  cancelAllFades();
  disposeMedia({ removeTransition: true });
  stopChampionBed();

  const snap = undoStack.pop();
  const restored = deserializeState(snap);
  if (!restored) {
    // Snapshot was corrupt — give up cleanly
    error = 'Could not undo that pick.';
    render();
    return;
  }

  state = restored;
  error = '';
  prunePreviewCache();
  saveProgress({ immediate: true });
  render();
}

function onPick(side) {
  if (!state || roundTransition || matchWinBeat || state.finished) return;
  if (side !== 'a' && side !== 'b') return;
  const matchBefore = currentMatch(state);
  if (!matchBefore) return;

  const winnerSong = side === 'a' ? matchBefore.a : matchBefore.b;
  const fromLabel = progress(state).roundLabel;
  const prevRound = state.roundNumber;
  const prevRegion = matchBefore?.region;

  // Snapshot *before* the pick so Undo can come back here
  pushUndoSnapshot();

  state = pickWinner(state, side);
  // Loser's preview URL can leave memory now
  prunePreviewCache();
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

  const wavePayload =
    waveChanged || enteredFinal
      ? {
          fromLabel,
          toLabel: progress(state).roundLabel,
          remaining: state.remaining,
          transitionSong: takeNextTransitionSong(),
        }
      : null;

  // Solo: party-style win screen after every pick (unless “Skip win transitions”)
  // Re-read pref in case setup checkbox changed it this session
  skipWinBeat = loadSkipWinBeatPref();
  if (!skipWinBeat && isSongLike(winnerSong)) {
    scheduleMatchWinBeat(
      winnerSong,
      wavePayload
        ? { type: 'wave', payload: wavePayload, ms: 4200 }
        : { type: 'done' }
    );
    return;
  }

  if (wavePayload) {
    scheduleTransition(wavePayload, 4200);
    return;
  }

  render();
}

function onQuit() {
  loadGeneration += 1;
  clearTransitionTimer();
  roundTransition = null;
  matchWinBeat = null;
  fadingAudio.clear();
  disposeMedia({ removeTransition: true });
  stopChampionBed();
  destroyAllYouTubePlayers();
  clearPreviewCache();
  clearSavedProgress();
  clearUndoStack();
  clearSetupDraft();
  state = null;
  playlistTracks = [];
  transitionSongIndex = 0;
  clearTrackVolumes();
  error = '';
  clearStageVibe();
  uiMode = 'home';
  render();
}

/**
 * Keyboard shortcuts while a match is on screen (or undo on results).
 * Ignored when typing in a text field so setup still works.
 * Checkboxes (e.g. skip win transitions) do NOT block 1/2/R.
 */
function onMatchKeydown(e) {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;

  const el = e.target;
  const tag = (el && el.tagName) || '';
  if (tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) {
    return;
  }
  if (tag === 'INPUT') {
    const type = (el.type || 'text').toLowerCase();
    // Only block real typing fields — not checkbox/radio/range/button
    if (
      type === 'text' ||
      type === 'url' ||
      type === 'search' ||
      type === 'email' ||
      type === 'password' ||
      type === 'number' ||
      type === '' ||
      type === 'tel'
    ) {
      return;
    }
  }

  const key = e.key;

  // Undo: U (also works on results / during transition if stack has entries)
  if (key === 'u' || key === 'U') {
    if (!undoStack.length) return;
    e.preventDefault();
    onUndo();
    return;
  }

  // During transition screens, only undo is allowed (not accidental picks)
  if (roundTransition || matchWinBeat || loading) return;

  if (state?.finished) return;

  if (!state || !currentMatch(state)) return;

  // e.key is "1"/"2"; e.code is "Digit1"/"Digit2" (numrow) or "Numpad1"/…
  if (key === '1' || e.code === 'Digit1' || e.code === 'Numpad1') {
    e.preventDefault();
    onPick('a');
    return;
  }
  if (key === '2' || e.code === 'Digit2' || e.code === 'Numpad2') {
    e.preventDefault();
    onPick('b');
    return;
  }
  if (key === 'r' || key === 'R') {
    e.preventDefault();
    onRandomPick();
  }
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
const linkRoom = parseRoomFromUrl();

// Global solo shortcuts (party has its own keys inside party-app)
window.addEventListener('keydown', onMatchKeydown);
// Idle baseline wave; becomes a real scope when a preview plays
startScope();

// Share link ?room=CODE → open party join (don't drop into a restored solo game)
if (linkRoom.length === 6) {
  // Keep any solo save on disk; just don't enter solo UI this load
  state = null;
  roundTransition = null;
  matchWinBeat = null;
  clearUndoStack();
  enterParty();
} else {
  if (restored) {
    state = restored;
    roundTransition = null;
    uiMode = 'solo';
    clearUndoStack();
  }
  render();
}
