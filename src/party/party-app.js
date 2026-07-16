/**
 * Party / multiplayer UI (Kahoot-style).
 * Connects to server WebSocket at /party. Solo mode is separate in main.js.
 */
import {
  prepareMediaElement,
  connectMediaElement,
  disconnectMediaElement,
  resumeAudioContext,
  kickScopeFromPlayback,
} from '../scope.js';
import {
  ensurePreviewUrl,
  prefetchMatchPreviews,
  prefetchSongPreview,
} from '../preview-cache.js';
import { buildPartyBracketHtml, wirePartyBracketTabs } from './party-bracket.js';

/**
 * Identity (name / color / avatar) is NOT persisted across page refresh.
 * User picks a fresh look every time they open/join party.
 * (Future custom PFPs may use a separate key — never auto-fill name/color.)
 * Old key cleared on load so prior sessions don't leak back.
 */
const PREFS_KEY_LEGACY = 'playlist-bracket-party-prefs-v1';
const VOL_KEY = 'playlist-bracket-party-vol-v1';
const PLAYMODE_PREF_KEY = 'playlist-bracket-party-playmode-v1';
/** Custom PFP image (data URL) — saved in this browser only; name/color still fresh each visit */
const PFP_KEY = 'playlist-bracket-party-pfp-v1';
const PFP_MAX_EDGE = 128; // px — keeps chips sharp, payloads small
const PFP_JPEG_QUALITY = 0.82;
/**
 * Session token must be PER TAB or multi-tab testing collapses to 1–2 players
 * (shared localStorage made every tab “rejoin” the same seat).
 */
const TAB_SESSION_KEY = 'playlist-bracket-party-tab-session-v1';
const COLORS_FALLBACK = [
  { id: 'red', hex: '#ef4444', label: 'Red' },
  { id: 'orange', hex: '#f97316', label: 'Orange' },
  { id: 'amber', hex: '#f59e0b', label: 'Amber' },
  { id: 'green', hex: '#22c55e', label: 'Green' },
  { id: 'teal', hex: '#14b8a6', label: 'Teal' },
  { id: 'blue', hex: '#3b82f6', label: 'Blue' },
  { id: 'indigo', hex: '#6366f1', label: 'Indigo' },
  { id: 'purple', hex: '#a855f7', label: 'Purple' },
  { id: 'pink', hex: '#ec4899', label: 'Pink' },
  { id: 'slate', hex: '#94a3b8', label: 'Slate' },
];
const AVATARS_FALLBACK = [
  { id: 'frog', emoji: '🐸', label: 'Frog' },
  { id: 'fox', emoji: '🦊', label: 'Fox' },
  { id: 'cat', emoji: '🐱', label: 'Cat' },
  { id: 'dog', emoji: '🐶', label: 'Dog' },
  { id: 'owl', emoji: '🦉', label: 'Owl' },
  { id: 'alien', emoji: '👽', label: 'Alien' },
  { id: 'robot', emoji: '🤖', label: 'Robot' },
  { id: 'ghost', emoji: '👻', label: 'Ghost' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'moon', emoji: '🌙', label: 'Moon' },
  { id: 'pizza', emoji: '🍕', label: 'Pizza' },
  { id: 'skull', emoji: '💀', label: 'Skull' },
];

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function colorHex(id, colors) {
  return (colors || COLORS_FALLBACK).find((c) => c.id === id)?.hex || '#94a3b8';
}

function avatarEmoji(id, avatars) {
  return (avatars || AVATARS_FALLBACK).find((a) => a.id === id)?.emoji || '🎵';
}

function loadSavedPfp() {
  try {
    const s = localStorage.getItem(PFP_KEY);
    if (s && s.startsWith('data:image/')) return s;
  } catch {
  }
  return null;
}

function saveSavedPfp(dataUrl) {
  try {
    if (dataUrl && dataUrl.startsWith('data:image/')) {
      localStorage.setItem(PFP_KEY, dataUrl);
    } else {
      localStorage.removeItem(PFP_KEY);
    }
  } catch {
    // Quota exceeded — ignore; user can still play with emoji avatar
  }
}

/** True if this looks like an image File/Blob (type can be empty on some Windows pastes). */
function looksLikeImageFile(file) {
  if (!file) return false;
  const t = String(file.type || '').toLowerCase();
  if (t.startsWith('image/')) return true;
  // Clipboard/OS sometimes leaves type blank — check extension
  const name = String(file.name || '').toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name) || t === '';
}

/**
 * Load a File/Blob/data-URL into an HTMLImageElement.
 * Prefer object URLs for Files so we don't stuff multi‑MB strings into HTML.
 */
function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let objectUrl = null;
    img.onload = () => {
      // Keep natural size; revoke later after crop confirm if object URL
      resolve({ img, objectUrl });
    };
    img.onerror = () => {
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {
        }
      }
      reject(new Error('bad image'));
    };
    if (typeof source === 'string') {
      img.src = source;
    } else if (typeof Blob !== 'undefined' && source instanceof Blob) {
      try {
        objectUrl = URL.createObjectURL(source);
        img.src = objectUrl;
      } catch {
        // Fallback: FileReader → data URL
        const reader = new FileReader();
        reader.onload = () => {
          img.src = String(reader.result || '');
        };
        reader.onerror = () => reject(new Error('read fail'));
        reader.readAsDataURL(source);
      }
    } else {
      reject(new Error('bad source'));
    }
  });
}

/**
 * Export square crop from natural image coords → small JPEG data URL.
 * sx,sy = top-left of crop in image pixels; sw = side length in image pixels.
 */
function exportCroppedPfp(img, sx, sy, sw) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = PFP_MAX_EDGE;
    canvas.height = PFP_MAX_EDGE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, sx, sy, sw, sw, 0, 0, PFP_MAX_EDGE, PFP_MAX_EDGE);
    const out = canvas.toDataURL('image/jpeg', PFP_JPEG_QUALITY);
    return out && out.length < 120000 ? out : null;
  } catch {
    return null;
  }
}

/** Wipe legacy identity prefs so refreshes never restore name/color/avatar. */
function clearLegacyIdentityPrefs() {
  try {
    localStorage.removeItem(PREFS_KEY_LEGACY);
  } catch {
  }
}

/**
 * Tab session token: only for socket reconnect *within* a session after join.
 * Cleared on full party app start so a page refresh always creates a new seat
 * (user must pick name/color/avatar again — never silent rejoin as old profile).
 */
function getTabSessionToken() {
  try {
    let t = sessionStorage.getItem(TAB_SESSION_KEY);
    if (!t) {
      t = `tab_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
      sessionStorage.setItem(TAB_SESSION_KEY, t);
    }
    return t;
  } catch {
    return `tab_${Math.random().toString(36).slice(2)}`;
  }
}

function setTabSessionToken(token) {
  if (!token) return;
  try {
    sessionStorage.setItem(TAB_SESSION_KEY, token);
  } catch {
  }
}

function clearTabSessionToken() {
  try {
    sessionStorage.removeItem(TAB_SESSION_KEY);
  } catch {
  }
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Dev: Vite proxies /party → :3001. Prod: same host as the page.
  return `${proto}//${location.host}/party`;
}

/** Normalize a room code from typing or URL (6 chars, no ambiguous glyphs in generator). */
export function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6);
}

/** Read ?room= or ?code= from the current page URL. */
export function parseRoomFromUrl() {
  try {
    const u = new URL(location.href);
    return normalizeRoomCode(u.searchParams.get('room') || u.searchParams.get('code') || '');
  } catch {
    return '';
  }
}

/** Full share URL friends can open (works on localhost and onrender.com). */
export function roomShareUrl(code) {
  const c = normalizeRoomCode(code);
  const u = new URL(location.href);
  u.search = '';
  u.hash = '';
  if (c) u.searchParams.set('room', c);
  return u.toString();
}

/** Update the address bar without reloading (so Copy link stays in sync). */
export function setUrlRoomParam(code) {
  try {
    const u = new URL(location.href);
    const c = normalizeRoomCode(code);
    if (c) u.searchParams.set('room', c);
    else u.searchParams.delete('room');
    u.searchParams.delete('code');
    history.replaceState({}, '', u.pathname + u.search + u.hash);
  } catch {
  }
}

/**
 * @param {HTMLElement} root
 * @param {{ onExit: () => void }} opts
 */
export function startPartyApp(root, opts) {
  const onExit = opts.onExit || (() => {});

  let ws = null;
  let state = null;
  let colors = COLORS_FALLBACK;
  let avatars = AVATARS_FALLBACK;
  let screen = 'gate'; // gate | live
  let gateError = '';
  let gateMode = 'join'; // join | create
  let connecting = false;
  let exportText = '';
  let statusLine = '';
  let playSide = null; // which local/sync side is loaded
  let audioEl = null;
  let winnerPlaySongId = null;
  /** @type {Set<string>} trackIds with in-flight playPreview (not the shared URL cache) */
  let playInflight = new Set();
  let lastSyncedKey = null; // trackId+playing for sync dedupe
  let eqRaf = 0;
  /** Bumps to cancel vote-timer setTimeout chains after re-render / destroy */
  let uiEpoch = 0;
  /** Bumps to ignore stale async playPreview completions */
  let playGen = 0;
  /** Abort join/create connect retry loops */
  let connectEpoch = 0;
  /** Bound once; removed on destroy */
  let onPfpPaste = null;
  let destroyed = false;
  let localVolume = 0.25;
  try {
    const v = Number(localStorage.getItem(VOL_KEY));
    if (Number.isFinite(v)) localVolume = Math.min(1, Math.max(0, v));
  } catch {
  }

  // Fresh identity every party session / full page load
  clearLegacyIdentityPrefs();
  clearTabSessionToken();
  const urlRoom = parseRoomFromUrl();
  /** True after server said room ended — so socket onclose isn't treated as a random drop */
  let endedByHost = false;
  /** Local chat only (no history from before you joined) */
  let chatMessages = [];
  let chatOpen = true;
  let chatDraft = '';
  /**
   * Interactive crop UI after paste/upload.
   * scale = display pixels per image pixel (image drawn at naturalW * scale).
   * ox, oy = image top-left relative to the square viewport (display px).
   */
  let cropper = null; // { img, naturalW, naturalH, scale, minScale, maxScale, ox, oy, viewSize }
  let cropDrag = null; // { startX, startY, origOx, origOy }
  const form = {
    displayName: '',
    color: 'purple',
    avatar: 'frog',
    /** data URL or null — may load from browser storage */
    pfp: loadSavedPfp(),
    code: urlRoom || '',
    playlistUrl: '',
  };
  // Link with ?room= → join tab (not host); never auto-join without a fresh name
  if (urlRoom.length === 6) {
    gateMode = 'join';
  }

  async function copyText(text, btn, okLabel = 'Copied!') {
    const prev = btn?.textContent;
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        btn.textContent = okLabel;
        setTimeout(() => {
          if (btn.isConnected && prev != null) btn.textContent = prev;
        }, 1500);
      }
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        if (btn) {
          btn.textContent = okLabel;
          setTimeout(() => {
            if (btn.isConnected && prev != null) btn.textContent = prev;
          }, 1500);
        }
        return true;
      } catch {
        if (btn) btn.textContent = 'Copy failed';
        return false;
      }
    }
  }

  function hardStopAudio() {
    stopEq();
    playInflight.clear();
    playGen += 1; // abandon in-flight playPreview
    if (!audioEl) {
      playSide = null;
      lastSyncedKey = null;
      return;
    }
    try {
      audioEl.pause();
      audioEl.onended = null;
      audioEl.onerror = null;
      audioEl.removeAttribute('src');
      delete audioEl.dataset.trackId;
      audioEl.load();
    } catch {
    }
    playSide = null;
    lastSyncedKey = null;
  }

  function disposePartyAudio() {
    hardStopAudio();
    if (!audioEl) return;
    try {
      disconnectMediaElement(audioEl);
    } catch {
    }
    try {
      audioEl.remove();
    } catch {
    }
    audioEl = null;
  }

  function ensureAudio() {
    if (audioEl && audioEl.isConnected) return audioEl;
    if (audioEl && !audioEl.isConnected) {
      try {
        disconnectMediaElement(audioEl);
      } catch {
      }
      audioEl = null;
    }
    audioEl = document.createElement('audio');
    audioEl.id = 'party-audio';
    audioEl.hidden = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.preload = 'none';
    document.body.appendChild(audioEl);
    return audioEl;
  }

  function setLocalVolume(vol01) {
    localVolume = Math.min(1, Math.max(0, vol01));
    try {
      localStorage.setItem(VOL_KEY, String(localVolume));
    } catch {
    }
    if (audioEl) {
      try {
        audioEl.volume = localVolume;
      } catch {
      }
    }
    root.querySelectorAll('[data-party-vol-label]').forEach((el) => {
      el.textContent = `${Math.round(localVolume * 100)}%`;
    });
    root.querySelectorAll('[data-party-vol]').forEach((el) => {
      el.value = String(Math.round(localVolume * 100));
    });
  }

  function stopEq() {
    if (eqRaf) {
      cancelAnimationFrame(eqRaf);
      eqRaf = 0;
    }
  }

  /** Simple DJ equalizer bars under the active song card. */
  function startEq(side) {
    stopEq();
    const canvas = root.querySelector(`[data-eq="${side}"]`);
    if (!canvas || !audioEl) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const bars = 16;
    const myEpoch = uiEpoch;
    const tick = () => {
      if (destroyed || myEpoch !== uiEpoch || !canvas.isConnected) {
        eqRaf = 0;
        return;
      }
      if (!audioEl || audioEl.paused) {
        ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        // Stop spinning when paused — restart via playPreview/startEq
        eqRaf = 0;
        return;
      }
      const w = canvas.width;
      const h = canvas.height;
      ctx2d.clearRect(0, 0, w, h);
      const bw = w / bars;
      // Fake-reactive from currentTime (works without Analyser on every path)
      const t = audioEl.currentTime || 0;
      for (let i = 0; i < bars; i++) {
        const wave =
          0.25 +
          0.55 * Math.abs(Math.sin(t * 4.2 + i * 0.55)) *
            (0.4 + 0.6 * Math.abs(Math.sin(t * 1.7 + i)));
        const bh = wave * h * (0.5 + localVolume * 0.5);
        ctx2d.fillStyle = `rgba(167, 139, 250, ${0.35 + wave * 0.5})`;
        ctx2d.fillRect(i * bw + 1, h - bh, bw - 2, bh);
      }
      eqRaf = requestAnimationFrame(tick);
    };
    // Size canvas
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(80, Math.floor(rect.width * (window.devicePixelRatio || 1)));
    canvas.height = Math.max(28, Math.floor(36 * (window.devicePixelRatio || 1)));
    eqRaf = requestAnimationFrame(tick);
  }

  /**
   * Play a Spotify preview. quiet=true avoids status spam.
   * continuous=true keeps going if same track already playing (champion handoff).
   */
  async function playPreview(song, side, { quiet = false, continuous = false } = {}) {
    if (destroyed || !song?.id) return;

    if (continuous && audioEl?.src && !audioEl.paused && audioEl.dataset.trackId === song.id) {
      playSide = side;
      audioEl.volume = localVolume;
      startEq(side);
      return;
    }

    // Don't stack concurrent plays of celebration sides
    if (
      playInflight.has(song.id) &&
      (side === 'win' || side === 'winner' || side === 'champion')
    ) {
      return;
    }

    playInflight.add(song.id);
    const audio = ensureAudio();
    const myPlay = ++playGen;

    try {
      const previewUrl = await ensurePreviewUrl(song.id);
      if (destroyed || myPlay !== playGen) {
        playInflight.delete(song.id);
        return;
      }
      if (!previewUrl) {
        playInflight.delete(song.id);
        if (state?.you?.isHost && (side === 'a' || side === 'b')) {
          send('report_no_preview', { side });
        }
        if (!quiet) {
          statusLine = 'No preview for this track.';
          const st = root.querySelector('.party-status');
          if (st) st.textContent = statusLine;
        }
        return;
      }
      prepareMediaElement(audio);
      // Avoid restarting same URL mid-play (champion continuity)
      if (!(continuous && audio.dataset.trackId === song.id && audio.src)) {
        audio.src = previewUrl;
        audio.dataset.trackId = song.id;
      }
      connectMediaElement(audio);
      audio.volume = localVolume;
      await resumeAudioContext();
      if (destroyed || myPlay !== playGen) {
        playInflight.delete(song.id);
        return;
      }
      if (audio.paused) await audio.play();
      kickScopeFromPlayback();
      playSide = side;
      statusLine = '';
      playInflight.delete(song.id);
      startEq(side);
      if (!quiet && side !== 'winner' && side !== 'champion' && side !== 'win') {
        root.querySelectorAll('.cover-play-btn').forEach((btn) => {
          const s = btn.getAttribute('data-play');
          btn.classList.toggle('is-playing', s === side);
          const icon = btn.querySelector('.cover-play-icon');
          if (icon) icon.textContent = s === side ? '❚❚' : '▶';
        });
      }
    } catch {
      playInflight.delete(song.id);
      if (!quiet) statusLine = 'Could not play preview.';
    }
  }

  /** When winner celebration starts, warm next match previews in the background. */
  function prefetchUpcomingFromState(s) {
    if (!s) return;
    if (s.phase === 'winner' && s.winnerBeat?.upcomingMatch) {
      prefetchMatchPreviews(s.winnerBeat.upcomingMatch);
    }
    // Current match (entering match phase or still there) — keep hot
    if (s.phase === 'match' && s.match) {
      prefetchMatchPreviews(s.match);
    }
    if (s.phase === 'champion' && s.champion) {
      prefetchSongPreview(s.champion);
    }
  }

  /** Follow server nowPlaying (Sync + auto winner/champion). */
  function applyNowPlaying(np) {
    // Explicit stop from server (end of round celebration → next match)
    if (!np || np.stop || (!np.trackId && !np.playing)) {
      hardStopAudio();
      lastSyncedKey = 'stopped';
      return;
    }
    if (!np.trackId || !np.song) return;
    const key = `${np.trackId}:${np.playing ? 1 : 0}:${np.side}`;
    if (key === lastSyncedKey && np.playing) return;
    lastSyncedKey = key;
    if (!np.playing) {
      try {
        audioEl?.pause();
      } catch {
      }
      stopEq();
      playSide = null;
      return;
    }
    const cont =
      (np.side === 'champion' || np.side === 'winner') &&
      audioEl?.dataset?.trackId === np.trackId;
    playPreview(np.song, np.side, { quiet: true, continuous: cont });
  }

  function connect() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    connecting = true;
    gateError = '';
    render();
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      connecting = false;
      statusLine = '';
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        if (Array.isArray(msg.colors)) colors = msg.colors;
        if (Array.isArray(msg.avatars)) avatars = msg.avatars;
        render();
        return;
      }
      if (msg.type === 'joined' || msg.type === 'state') {
        const prevPhase = state?.phase;
        state = msg.state;
        screen = 'live';
        gateError = '';
        // Keep address bar shareable: ?room=CODE
        if (state?.code) setUrlRoomParam(state.code);
        if (state?.you?.sessionToken) {
          // Tab session only (rejoin same tab if socket drops) — not cross-refresh identity
          setTabSessionToken(state.you.sessionToken);
        }
        // Continuous audio ONLY for winner celebration → final champion results
        if (prevPhase === 'winner' && state?.phase === 'champion') {
          // keep same track playing into results screen
        } else if (
          prevPhase === 'winner' &&
          state?.phase !== 'winner' &&
          state?.phase !== 'champion'
        ) {
          // Next match (or lobby): stop celebration audio so it doesn't bleed
          hardStopAudio();
          lastSyncedKey = null;
        } else if (
          prevPhase === 'champion' &&
          state?.phase !== 'champion'
        ) {
          hardStopAudio();
          lastSyncedKey = null;
        }
        render();
        // After DOM exists, apply sync / auto playback
        if (state?.nowPlaying) {
          applyNowPlaying(state.nowPlaying);
        }
        // If we entered a new match with no room track, celebration must not continue
        if (
          state?.phase === 'match' &&
          !state.nowPlaying?.playing &&
          (playSide === 'winner' ||
            playSide === 'win' ||
            (audioEl?.dataset?.trackId &&
              state.match &&
              audioEl.dataset.trackId !== state.match.a?.id &&
              audioEl.dataset.trackId !== state.match.b?.id))
        ) {
          hardStopAudio();
        }
        // Winner beat / match entry: fill preview cache while UI celebrates
        prefetchUpcomingFromState(state);
        return;
      }
      if (msg.type === 'chat') {
        // Live only — we never request/replay history (3B)
        if (msg.message?.id) {
          if (!chatMessages.some((m) => m.id === msg.message.id)) {
            chatMessages.push(msg.message);
            if (chatMessages.length > 150) chatMessages.shift();
          }
        }
        // Soft-update chat list without full re-render if possible
        const list = root.querySelector('#party-chat-list');
        if (list && msg.message) {
          list.appendChild(chatBubbleEl(msg.message));
          list.scrollTop = list.scrollHeight;
        } else {
          render();
        }
        return;
      }
      if (msg.type === 'export') {
        exportText = msg.data || '';
        render();
        return;
      }
      if (msg.type === 'ended') {
        endedByHost = true;
        hardStopAudio();
        state = null;
        screen = 'gate';
        gateMode = 'join';
        gateError = 'Room ended. Enter a code or open a new share link.';
        connecting = false;
        statusLine = '';
        chatMessages = [];
        // Drop share param so the dead code isn't sticky
        setUrlRoomParam('');
        form.code = '';
        try {
          ws?.close();
        } catch {
        }
        ws = null;
        render();
        return;
      }
      if (msg.type === 'error') {
        // Join/create failures drop back to gate with retry UI
        gateError = msg.error || 'Something went wrong.';
        statusLine = '';
        connecting = false;
        if (!state || screen !== 'live') {
          screen = 'gate';
          gateMode = 'join';
          if (form.code.length < 6 && urlRoom) form.code = urlRoom;
        }
        render();
        return;
      }
      if (msg.type === 'loading') {
        statusLine = 'Loading playlist…';
        render();
      }
    };
    ws.onclose = () => {
      connecting = false;
      if (endedByHost) {
        // Already handled by "ended" message
        return;
      }
      if (screen === 'live') {
        // Host ended room or server died — leave the live UI either way
        hardStopAudio();
        state = null;
        screen = 'gate';
        gateMode = 'join';
        gateError =
          gateError ||
          'Disconnected from the room. It may have ended — ask the host for a new code or link.';
        statusLine = '';
        render();
        return;
      }
      render();
    };
    ws.onerror = () => {
      connecting = false;
      gateError =
        'Could not connect to party server. Is `npm run dev` running (API on :3001)?';
      render();
    };
  }

  function send(type, payload = {}) {
    if (!ws || ws.readyState !== 1) {
      gateError = 'Not connected.';
      render();
      return;
    }
    ws.send(JSON.stringify({ type, ...payload }));
  }

  function createRoom() {
    endedByHost = false;
    gateError = '';
    chatMessages = [];
    const epoch = ++connectEpoch;
    connect();
    const tryCreate = () => {
      if (destroyed || epoch !== connectEpoch) return;
      if (ws?.readyState === 1) {
        send('create', {
          displayName: form.displayName,
          color: form.color,
          avatar: form.avatar,
          pfp: form.pfp || null,
          // Tab-only token (sessionStorage). Full page refresh = new identity form;
          // we still send token so a brief socket blip mid-game can rejoin the same seat.
          sessionToken: getTabSessionToken(),
        });
      } else if (ws?.readyState === 0) {
        setTimeout(tryCreate, 50);
      }
    };
    tryCreate();
  }

  function joinRoom() {
    endedByHost = false;
    gateError = '';
    chatMessages = []; // only messages after join (3B)
    const epoch = ++connectEpoch;
    connect();
    const code = normalizeRoomCode(form.code);
    const tryJoin = () => {
      if (destroyed || epoch !== connectEpoch) return;
      if (ws?.readyState === 1) {
        send('join', {
          code,
          displayName: form.displayName,
          color: form.color,
          avatar: form.avatar,
          pfp: form.pfp || null,
          sessionToken: getTabSessionToken(),
        });
      } else if (ws?.readyState === 0) {
        setTimeout(tryJoin, 50);
      }
    };
    tryJoin();
  }

  function leaveToMenu() {
    hardStopAudio();
    try {
      ws?.close();
    } catch {
    }
    ws = null;
    state = null;
    screen = 'gate';
    // Leaving party → clear share param so home isn't sticky-linked
    setUrlRoomParam('');
    onExit();
  }

  function chip(p, { grey = false, showRandom = false } = {}) {
    const hex = colorHex(p.color, colors);
    const em = avatarEmoji(p.avatar, avatars);
    const face = p.pfp
      ? `<img class="party-chip-pfp" src="${esc(p.pfp)}" alt="" />`
      : em;
    return `<span class="party-chip${grey ? ' is-voted' : ''}" style="--chip:${hex}">
      <span class="party-chip-av">${face}</span>
      <span class="party-chip-name">${esc(p.displayName)}${p.isHost ? ' ★' : ''}${
        showRandom ? ' 🎲' : ''
      }</span>
    </span>`;
  }

  function chatFaceHtml(m) {
    if (m.pfp) {
      return `<img class="party-chat-pfp" src="${esc(m.pfp)}" alt="" />`;
    }
    return `<span class="party-chat-emoji">${avatarEmoji(m.avatar, avatars)}</span>`;
  }

  function chatBubbleHtml(m) {
    const hex = colorHex(m.color, colors);
    const time = new Date(m.at || Date.now()).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `
      <div class="party-chat-msg" data-chat-id="${esc(m.id)}" style="--chip:${hex}">
        <div class="party-chat-face">${chatFaceHtml(m)}</div>
        <div class="party-chat-body">
          <div class="party-chat-meta">
            <strong class="party-chat-name">${esc(m.displayName || 'Player')}</strong>
            <span class="party-chat-time">${esc(time)}</span>
          </div>
          <p class="party-chat-text">${esc(m.text)}</p>
        </div>
      </div>`;
  }

  function chatBubbleEl(m) {
    const wrap = document.createElement('div');
    wrap.innerHTML = chatBubbleHtml(m).trim();
    return wrap.firstElementChild;
  }

  function chatPanelHtml() {
    const msgs = chatMessages.map((m) => chatBubbleHtml(m)).join('');
    return `
      <aside class="party-chat ${chatOpen ? 'is-open' : 'is-collapsed'}" id="party-chat" aria-label="Room chat">
        <button type="button" class="party-chat-toggle" id="party-chat-toggle" title="${
          chatOpen ? 'Hide chat' : 'Show chat'
        }">
          ${chatOpen ? '›' : '‹ Chat'}
        </button>
        <div class="party-chat-panel">
          <header class="party-chat-header">
            <strong>Chat</strong>
            <span class="muted small">this room</span>
          </header>
          <div class="party-chat-list" id="party-chat-list">${
            msgs || '<p class="party-chat-empty muted small">No messages yet — say hi.</p>'
          }</div>
          <form class="party-chat-compose" id="party-chat-form">
            <input
              type="text"
              id="party-chat-input"
              maxlength="300"
              placeholder="Message the room…"
              value="${esc(chatDraft)}"
              autocomplete="off"
            />
            <button type="submit" id="party-chat-send">Send</button>
          </form>
        </div>
      </aside>`;
  }

  function wireChat() {
    root.querySelector('#party-chat-toggle')?.addEventListener('click', () => {
      chatOpen = !chatOpen;
      render();
    });
    const input = root.querySelector('#party-chat-input');
    input?.addEventListener('input', (e) => {
      chatDraft = e.target.value;
    });
    root.querySelector('#party-chat-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = (input?.value || chatDraft || '').trim();
      if (!text) return;
      send('chat_send', { text });
      chatDraft = '';
      if (input) input.value = '';
    });
    const list = root.querySelector('#party-chat-list');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function wrapWithChat(mainHtml) {
    return `
      <div class="party-with-chat ${chatOpen ? 'chat-open' : 'chat-collapsed'}">
        <div class="party-main-col">${mainHtml}</div>
        ${chatPanelHtml()}
      </div>`;
  }

  /**
   * Open zoom/pan cropper for a pasted or uploaded image.
   * User frames their face in the circle, then Confirm saves to browser + form.
   */
  async function openPfpCropper(fileOrBlob) {
    if (!looksLikeImageFile(fileOrBlob) && !(fileOrBlob instanceof Blob)) {
      gateError = 'Please use an image file (PNG, JPG, or WebP).';
      render();
      return;
    }
    // Allow Blob with empty type (common when pasting on Windows)
    if (fileOrBlob instanceof Blob && fileOrBlob.type && !fileOrBlob.type.startsWith('image/') && !looksLikeImageFile(fileOrBlob)) {
      gateError = 'Please use an image file (PNG, JPG, or WebP).';
      render();
      return;
    }

    let loaded;
    try {
      loaded = await loadImageElement(fileOrBlob);
    } catch (err) {
      console.warn('[pfp] load failed', err);
      gateError = 'Could not read that image. Try a smaller PNG or JPG.';
      render();
      return;
    }
    const img = loaded.img;
    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;
    if (!naturalW || !naturalH) {
      gateError = 'Could not read that image.';
      render();
      return;
    }
    const viewSize = 280;
    // Min zoom: image fully covers the circle/square
    const minScale = Math.max(viewSize / naturalW, viewSize / naturalH);
    const maxScale = Math.max(minScale * 4, minScale + 0.01);
    const scale = minScale;
    // Center image in viewport
    const ox = (viewSize - naturalW * scale) / 2;
    const oy = (viewSize - naturalH * scale) / 2;

    // Drop previous cropper object URL if any
    if (cropper?.objectUrl) {
      try {
        URL.revokeObjectURL(cropper.objectUrl);
      } catch {
      }
    }

    cropper = {
      img,
      objectUrl: loaded.objectUrl || null,
      displaySrc: img.src, // use for <img> via JS, not innerHTML
      naturalW,
      naturalH,
      scale,
      minScale,
      maxScale,
      ox,
      oy,
      viewSize,
    };
    gateError = '';
    render();
  }

  function clampCropperPan() {
    if (!cropper) return;
    const { naturalW, naturalH, scale, viewSize } = cropper;
    const dispW = naturalW * scale;
    const dispH = naturalH * scale;
    // Image must always cover the viewport
    const minOx = viewSize - dispW;
    const minOy = viewSize - dispH;
    const maxOx = 0;
    const maxOy = 0;
    cropper.ox = Math.min(maxOx, Math.max(minOx, cropper.ox));
    cropper.oy = Math.min(maxOy, Math.max(minOy, cropper.oy));
  }

  function setCropperScale(newScale, pivotX, pivotY) {
    if (!cropper) return;
    const old = cropper.scale;
    const scale = Math.min(cropper.maxScale, Math.max(cropper.minScale, newScale));
    // Zoom toward pointer (or center)
    const px = pivotX ?? cropper.viewSize / 2;
    const py = pivotY ?? cropper.viewSize / 2;
    const imgX = (px - cropper.ox) / old;
    const imgY = (py - cropper.oy) / old;
    cropper.scale = scale;
    cropper.ox = px - imgX * scale;
    cropper.oy = py - imgY * scale;
    clampCropperPan();
  }

  function confirmCropper() {
    if (!cropper) return;
    const { img, naturalW, naturalH, scale, ox, oy, viewSize, objectUrl } = cropper;
    // Viewport (0,0)-(viewSize) maps to image pixels
    const sx = Math.max(0, -ox / scale);
    const sy = Math.max(0, -oy / scale);
    const sw = viewSize / scale;
    const maxSx = Math.max(0, naturalW - sw);
    const maxSy = Math.max(0, naturalH - sw);
    const dataUrl = exportCroppedPfp(
      img,
      Math.min(maxSx, Math.max(0, sx)),
      Math.min(maxSy, Math.max(0, sy)),
      Math.min(sw, naturalW, naturalH)
    );
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
      }
    }
    cropper = null;
    cropDrag = null;
    if (!dataUrl) {
      gateError = 'Could not save that crop. Try again.';
      render();
      return;
    }
    form.pfp = dataUrl;
    saveSavedPfp(dataUrl);
    gateError = '';
    render();
  }

  function cancelCropper() {
    if (cropper?.objectUrl) {
      try {
        URL.revokeObjectURL(cropper.objectUrl);
      } catch {
      }
    }
    cropper = null;
    cropDrag = null;
    render();
  }

  function renderCropperOverlay() {
    if (!cropper) return;
    const { displaySrc, naturalW, naturalH, scale, ox, oy, viewSize, minScale, maxScale } =
      cropper;
    const dispW = naturalW * scale;
    const dispH = naturalH * scale;
    const zoomPct = Math.round(
      ((scale - minScale) / Math.max(0.0001, maxScale - minScale)) * 100
    );

    document.getElementById('pfp-crop-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'pfp-crop-overlay';
    overlay.id = 'pfp-crop-overlay';
    // Do NOT put multi-MB data URLs in HTML attributes — set src in JS
    overlay.innerHTML = `
      <div class="pfp-crop-modal" role="dialog" aria-modal="true" aria-label="Crop profile picture">
        <h3 class="pfp-crop-title">Frame your picture</h3>
        <p class="pfp-crop-hint muted small">Drag to move · scroll or slider to zoom · circle is your PFP</p>
        <div class="pfp-crop-viewport" id="pfp-crop-viewport" style="width:${viewSize}px;height:${viewSize}px">
          <img id="pfp-crop-img" class="pfp-crop-img" alt="" draggable="false" />
          <div class="pfp-crop-ring" aria-hidden="true"></div>
        </div>
        <label class="pfp-crop-zoom-row">
          <span>Zoom</span>
          <input type="range" id="pfp-crop-zoom" min="0" max="100" value="${zoomPct}" />
        </label>
        <div class="pfp-crop-actions">
          <button type="button" class="ghost" id="pfp-crop-cancel">Cancel</button>
          <button type="button" id="pfp-crop-ok">Use this crop</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const viewport = overlay.querySelector('#pfp-crop-viewport');
    const imgEl = overlay.querySelector('#pfp-crop-img');
    const zoomEl = overlay.querySelector('#pfp-crop-zoom');

    if (imgEl) {
      imgEl.src = displaySrc || cropper.img?.src || '';
      imgEl.style.width = `${dispW}px`;
      imgEl.style.height = `${dispH}px`;
      imgEl.style.transform = `translate(${ox}px,${oy}px)`;
    }

    const syncImgStyle = () => {
      if (!cropper || !imgEl) return;
      imgEl.style.width = `${cropper.naturalW * cropper.scale}px`;
      imgEl.style.height = `${cropper.naturalH * cropper.scale}px`;
      imgEl.style.transform = `translate(${cropper.ox}px,${cropper.oy}px)`;
    };

    zoomEl?.addEventListener('input', () => {
      if (!cropper) return;
      const t = Number(zoomEl.value) / 100;
      const next = cropper.minScale + t * (cropper.maxScale - cropper.minScale);
      setCropperScale(next);
      syncImgStyle();
    });

    const onPointerDown = (e) => {
      if (!cropper) return;
      e.preventDefault();
      const pt = e.clientX != null ? e : e.touches?.[0];
      if (!pt) return;
      cropDrag = {
        startX: pt.clientX,
        startY: pt.clientY,
        origOx: cropper.ox,
        origOy: cropper.oy,
      };
      try {
        viewport.setPointerCapture?.(e.pointerId);
      } catch {
      }
    };
    const onPointerMove = (e) => {
      if (!cropDrag || !cropper) return;
      const pt = e.clientX != null ? e : e.touches?.[0];
      if (!pt) return;
      cropper.ox = cropDrag.origOx + (pt.clientX - cropDrag.startX);
      cropper.oy = cropDrag.origOy + (pt.clientY - cropDrag.startY);
      clampCropperPan();
      syncImgStyle();
    };
    const onPointerUp = () => {
      cropDrag = null;
    };

    viewport?.addEventListener('pointerdown', onPointerDown);
    viewport?.addEventListener('pointermove', onPointerMove);
    viewport?.addEventListener('pointerup', onPointerUp);
    viewport?.addEventListener('pointercancel', onPointerUp);
    viewport?.addEventListener(
      'wheel',
      (e) => {
        if (!cropper) return;
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const factor = e.deltaY > 0 ? 0.92 : 1.08;
        setCropperScale(cropper.scale * factor, px, py);
        if (zoomEl) {
          zoomEl.value = String(
            Math.round(
              ((cropper.scale - cropper.minScale) /
                Math.max(0.0001, cropper.maxScale - cropper.minScale)) *
                100
            )
          );
        }
        syncImgStyle();
      },
      { passive: false }
    );

    overlay.querySelector('#pfp-crop-cancel')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      cancelCropper();
    });
    overlay.querySelector('#pfp-crop-ok')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      confirmCropper();
    });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cancelCropper();
    });
  }

  function renderGate() {
    const colorOpts = colors
      .map(
        (c) => `
      <label class="party-swatch${form.color === c.id ? ' is-on' : ''}" title="${esc(c.label)}">
        <input type="radio" name="pcolor" value="${esc(c.id)}" ${
          form.color === c.id ? 'checked' : ''
        } />
        <span style="background:${esc(c.hex)}"></span>
      </label>`
      )
      .join('');
    const avOpts = avatars
      .map(
        (a) => `
      <label class="party-avatar-pick${form.avatar === a.id ? ' is-on' : ''}" title="${esc(a.label)}">
        <input type="radio" name="pavatar" value="${esc(a.id)}" ${
          form.avatar === a.id ? 'checked' : ''
        } />
        <span>${a.emoji}</span>
      </label>`
      )
      .join('');

    root.innerHTML = `
      <div class="setup-shell party-shell">
        <div class="setup-bg" aria-hidden="true">
          <span class="swirl swirl-a"></span>
          <span class="swirl swirl-b"></span>
        </div>
        <header class="brand-header">
          <button type="button" class="brand-home" id="party-exit" data-home>Playlist Bracket</button>
          <p class="brand-sub">Play with friends</p>
        </header>
        <div class="card setup-card party-card">
          <div class="party-tabs">
            <button type="button" class="party-tab${gateMode === 'join' ? ' is-on' : ''}" data-gate="join">Join room</button>
            <button type="button" class="party-tab${gateMode === 'create' ? ' is-on' : ''}" data-gate="create">Host room</button>
          </div>

          <div class="field">
            <label for="pname">Display name</label>
            <input id="pname" maxlength="24" value="${esc(form.displayName)}" placeholder="Up to 24 characters" autocomplete="nickname" />
          </div>

          <div class="field">
            <label>Color</label>
            <div class="party-swatches">${colorOpts}</div>
          </div>

          <div class="field">
            <label>Avatar</label>
            <div class="party-avatars">${avOpts}</div>
          </div>

          <div class="field party-pfp-field">
            <label>Custom picture (optional)</label>
            <div class="party-pfp-row" id="party-pfp-drop">
              <div class="party-pfp-preview" aria-hidden="true">
                ${
                  form.pfp
                    ? `<img src="${esc(form.pfp)}" alt="" />`
                    : `<span class="party-pfp-placeholder">${avatarEmoji(form.avatar, avatars)}</span>`
                }
              </div>
              <div class="party-pfp-actions">
                <label class="party-pfp-upload ghost small-btn">
                  Upload image
                  <input type="file" id="pfp-file" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
                </label>
                <button type="button" class="ghost small-btn" id="pfp-clear" ${
                  form.pfp ? '' : 'disabled'
                }>Clear picture</button>
                <p class="setup-note party-pfp-hint">
                  Upload or <strong>paste</strong> (Ctrl+V) — then zoom &amp; drag to frame your face. Picture is saved in this browser; name &amp; color still reset each visit.
                </p>
              </div>
            </div>
          </div>

          ${
            gateMode === 'join'
              ? `<div class="field">
                  <label for="pcode">Room code</label>
                  <input id="pcode" maxlength="6" value="${esc(form.code)}" placeholder="6 characters" class="party-code-input" autocomplete="off" ${
                    parseRoomFromUrl().length === 6 ? 'aria-describedby="room-link-hint"' : ''
                  } />
                  ${
                    parseRoomFromUrl().length === 6
                      ? `<p class="setup-note" id="room-link-hint">Opened from a share link — code filled in.</p>`
                      : ''
                  }
                </div>`
              : `<p class="setup-note">You’ll get a 6-character code and a share link. Spotify playlists only in party for now.</p>`
          }

          ${
            gateError
              ? `<div class="error-box" role="alert">
                  <p>${esc(gateError)}</p>
                  <p class="small" style="margin:0.5rem 0 0">Check the code, or ask the host for a fresh link. You can edit the code below and try again.</p>
                </div>`
              : ''
          }

          <div class="form-actions">
            <button type="button" id="party-go" ${connecting ? 'disabled' : ''}>
              ${connecting ? 'Connecting…' : gateMode === 'join' ? 'Join room' : 'Create room'}
            </button>
            <button type="button" class="ghost" id="party-back-solo">Back to menu</button>
          </div>
        </div>
      </div>
    `;

    root.querySelectorAll('[data-gate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        gateMode = btn.getAttribute('data-gate');
        render();
      });
    });
    root.querySelector('#pname')?.addEventListener('input', (e) => {
      form.displayName = e.target.value.slice(0, 24);
    });
    root.querySelector('#pcode')?.addEventListener('input', (e) => {
      form.code = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      e.target.value = form.code;
    });
    root.querySelectorAll('input[name="pcolor"]').forEach((el) => {
      el.addEventListener('change', () => {
        form.color = el.value;
        render();
      });
    });
    root.querySelectorAll('input[name="pavatar"]').forEach((el) => {
      el.addEventListener('change', () => {
        form.avatar = el.value;
        // Keep custom pfp if set; emoji is fallback only
        render();
      });
    });

    const fileInput = root.querySelector('#pfp-file');
    fileInput?.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) {
        gateError = 'No file selected.';
        render();
        return;
      }
      try {
        await openPfpCropper(file);
      } catch (err) {
        console.warn('[pfp] upload error', err);
        gateError = 'Could not open that image.';
        render();
      }
    });
    root.querySelector('#pfp-clear')?.addEventListener('click', () => {
      form.pfp = null;
      saveSavedPfp(null);
      render();
    });
    // Paste image from clipboard on join/create (Ctrl+V) → opens cropper
    const pfpDrop = root.querySelector('#party-pfp-drop');
    if (pfpDrop) pfpDrop.tabIndex = 0;
    if (!onPfpPaste) {
      onPfpPaste = async (e) => {
        if (destroyed || screen !== 'gate') return;
        if (cropper) return; // already cropping
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
          if (item.type.startsWith('image/') || item.kind === 'file') {
            const file = item.getAsFile();
            if (!file) continue;
            // Skip non-images when kind is file
            if (file.type && !file.type.startsWith('image/') && !looksLikeImageFile(file)) {
              continue;
            }
            e.preventDefault();
            try {
              await openPfpCropper(file);
            } catch (err) {
              console.warn('[pfp] paste error', err);
              gateError = 'Could not open pasted image.';
              render();
            }
            break;
          }
        }
      };
      document.addEventListener('paste', onPfpPaste);
    }

    root.querySelector('#party-go')?.addEventListener('click', () => {
      if (!form.displayName.trim()) {
        gateError = 'Pick a display name.';
        render();
        return;
      }
      if (gateMode === 'join') {
        if (form.code.length < 6) {
          gateError = 'Enter the full 6-character code.';
          render();
          return;
        }
        joinRoom();
      } else {
        createRoom();
      }
    });
    root.querySelector('#party-back-solo')?.addEventListener('click', leaveToMenu);
    root.querySelector('#party-exit')?.addEventListener('click', leaveToMenu);
  }

  function renderLive() {
    const s = state;
    if (!s) return renderGate();
    const you = s.you || {};
    const isHost = Boolean(you.isHost);

    // Full-screen winner celebration — chat still available on the right
    if (s.phase === 'winner' && s.winnerBeat?.song) {
      root.innerHTML = wrapWithChat(renderWinnerFullscreen(s, isHost));
      wireLive(s, isHost);
      wireChat();
      return;
    }

    const players = s.players || [];
    const roster = players
      .map((p) => {
        const voted = (s.votedPlayerIds || []).includes(p.id);
        return chip(p, { grey: voted && s.phase === 'match' });
      })
      .join('');

    let body = '';

    if (s.phase === 'champion') {
      body = renderChampionResults(s, isHost);
    } else if (s.phase === 'lobby') {
      body = renderLobby(s, isHost);
    } else if (s.phase === 'match') {
      body = renderMatch(s, isHost);
    } else if (s.phase === 'tie_break' || s.phase === 'reveal') {
      body = renderTieOrLegacyReveal(s, isHost);
    } else {
      body = `<p class="muted">Phase: ${esc(s.phase)}</p>`;
    }

    const main = `
      <div class="party-live">
        <header class="party-top">
          <div class="party-code-block">
            <strong class="party-code-display" id="party-code-text">${esc(s.code)}</strong>
            <button type="button" class="ghost small-btn" id="p-copy-code" title="Copy room code">
              Copy code
            </button>
            <button type="button" class="ghost small-btn" id="p-copy-link" title="Copy share link for friends">
              Copy link
            </button>
          </div>
          <div class="party-top-actions">
            ${isHost ? `<button type="button" class="ghost small-btn" id="p-export">Export recovery</button>` : ''}
            ${isHost ? `<button type="button" class="ghost small-btn" id="p-end">End room</button>` : ''}
            <button type="button" class="ghost small-btn" id="p-leave">Leave</button>
          </div>
        </header>
        ${s.paused ? `<div class="party-banner">Paused — host must unpause to vote</div>` : ''}
        ${statusLine ? `<p class="party-status">${esc(statusLine)}</p>` : ''}
        ${s.error ? `<div class="error-box">${esc(s.error)}</div>` : ''}
        <div class="party-roster-bar">
          <span class="small muted">Players</span>
          <div class="party-roster">${roster}</div>
        </div>
        ${body}
        ${
          exportText
            ? `<div class="card party-export"><p class="small">Recovery blob (save this):</p>
               <textarea readonly rows="4" id="export-area">${esc(exportText)}</textarea>
               <button type="button" class="ghost" id="copy-export">Copy</button></div>`
            : ''
        }
      </div>
    `;

    root.innerHTML = wrapWithChat(main);
    wireLive(s, isHost);
    wireChat();
  }

  /** Big full-viewport winner art + who voted for it. */
  function renderWinnerFullscreen(s, isHost) {
    const beat = s.winnerBeat;
    const song = beat.song;
    const loser = beat.loserSong;
    const voters = beat.voters || [];
    const losers = beat.losers || [];
    const abstain = beat.abstentions || s.abstentions || [];

    const winArt = song?.image
      ? `<img src="${esc(song.image)}" alt="" class="party-win-art-full" />`
      : `<div class="party-win-art-full party-win-art-fallback" aria-hidden="true">🎵</div>`;
    const loseArt = loser?.image
      ? `<img src="${esc(loser.image)}" alt="" class="party-lose-art" />`
      : `<div class="party-lose-art party-win-art-fallback" aria-hidden="true">🎵</div>`;

    const winChips = voters.map((p) => chip(p, { showRandom: p.random })).join('');
    const loseChips = losers.map((p) => chip(p, { showRandom: p.random })).join('');
    const abstainChips = abstain
      .map((p) => chip({ ...p, displayName: `${p.displayName} · abstain` }, { grey: true }))
      .join('');

    return `
      <div class="party-winner-full">
        <div class="party-winner-full-inner party-winner-duel">
          <p class="party-winner-label">Match result</p>
          <div class="party-win-duel-row">
            <div class="party-win-col party-win-col-winner">
              <span class="party-win-col-tag">Winner</span>
              <div class="party-win-art-stage">
                ${winArt}
              </div>
              <h1 class="party-winner-title">${esc(song?.name || '')}</h1>
              <p class="party-winner-artists">${esc(song?.artists || '')}</p>
              <div class="party-on-art-full party-vote-chips">${
                winChips || '<span class="muted small">No votes</span>'
              }</div>
            </div>
            ${
              loser
                ? `<div class="party-win-col party-win-col-loser">
              <span class="party-win-col-tag">Loser</span>
              <div class="party-lose-art-stage">
                ${loseArt}
              </div>
              <h2 class="party-loser-title">${esc(loser.name || '')}</h2>
              <p class="party-winner-artists">${esc(loser.artists || '')}</p>
              <div class="party-on-art-full party-vote-chips">${
                loseChips || '<span class="muted small">No votes</span>'
              }</div>
            </div>`
                : ''
            }
          </div>
          ${abstainChips ? `<div class="party-abstain-row">${abstainChips}</div>` : ''}
          <p class="muted small">Next match in a moment…</p>
          ${
            isHost
              ? `<button type="button" class="ghost" id="p-skip-winner">Skip · next match</button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  /** Solo-style end screen + full bracket views until host New lobby. */
  function renderChampionResults(s, isHost) {
    const c = s.champion;
    const r = s.results || {};
    if (!c) {
      return `<div class="card"><p>Tournament finished.</p></div>`;
    }
    const art = c.image
      ? `<img class="cover-art-img" src="${esc(c.image)}" alt="" />`
      : `<div class="cover-art-fallback" aria-hidden="true">🏆</div>`;
    const plImg = r.playlistImage
      ? `<img src="${esc(r.playlistImage)}" alt="" width="120" height="120" />`
      : '';
    const volPct = Math.round(localVolume * 100);
    const history = s.history || [];
    const bracketHtml = buildPartyBracketHtml(history, c, r.initialCount || 0);

    return `
      <div class="card results party-results">
        <div class="results-badge">🏆 Champion</div>
        <div class="playlist-hero">
          ${plImg}
          <h2>${esc(r.playlistName || s.playlist?.name || 'Playlist')}</h2>
          <p class="small muted">${r.initialCount || '?'} songs · ${r.matchups || '?'} matchups</p>
        </div>
        <div class="champion-block">
          <p class="label">Winner</p>
          <h3>${esc(c.name)}</h3>
          <p class="artists">${esc(c.artists || '')}</p>
          <div class="card-action-slot volume-control champion-volume">
            <span class="volume-icon" aria-hidden="true">🔊</span>
            <input type="range" class="volume-slider" data-party-vol min="0" max="100" step="1" value="${volPct}" aria-label="Volume" />
            <span class="volume-pct" data-party-vol-label>${volPct}%</span>
          </div>
          <div class="cover-player champion-cover">
            <button type="button" class="cover-play-btn${
              playSide === 'champion' || s.nowPlaying?.side === 'champion' ? ' is-playing' : ''
            }" id="play-party-champion" aria-label="Play champion preview">
              <span class="cover-art">${art}</span>
              <span class="cover-play-icon" aria-hidden="true">${
                playSide === 'champion' || s.nowPlaying?.playing ? '❚❚' : '▶'
              }</span>
            </button>
            <canvas class="party-eq party-eq-champ" data-eq="champion" aria-hidden="true"></canvas>
          </div>
        </div>
        <div class="results-actions">
          ${
            isHost
              ? `<button type="button" id="p-new-lobby">New lobby</button>`
              : `<p class="muted small">Waiting for host to open a new lobby…</p>`
          }
        </div>
        <section class="bracket-section" id="bracket-section">
          <h3>Tournament bracket</h3>
          ${bracketHtml}
        </section>
      </div>
    `;
  }

  function renderLobby(s, isHost) {
    const pl = s.playlist;
    return `
      <div class="card party-lobby">
        <h2>Lobby</h2>
        ${
          isHost
            ? `
          <div class="party-settings">
            <h3 class="small">Host settings</h3>
            <label class="party-setting-row">Matchup
              <select id="p-seed">
                <option value="order" ${s.settings?.seeding === 'order' ? 'selected' : ''}>Playlist order</option>
                <option value="shuffle" ${s.settings?.seeding === 'shuffle' ? 'selected' : ''}>Shuffle</option>
              </select>
            </label>
            <label class="party-setting-row">Play mode
              <select id="p-playmode">
                <option value="desync" ${s.settings?.playMode === 'desync' ? 'selected' : ''}>Desync (each device)</option>
                <option value="sync" ${s.settings?.playMode === 'sync' ? 'selected' : ''}>Sync (host plays for everyone)</option>
              </select>
            </label>
          </div>
          <div class="field">
            <label for="p-url">Spotify playlist link</label>
            <input id="p-url" type="url" placeholder="https://open.spotify.com/playlist/…" value="${esc(form.playlistUrl || s.playlistUrl || '')}" />
          </div>
          <div class="form-actions">
            <button type="button" id="p-load">Load playlist</button>
            <button type="button" id="p-start" ${pl ? '' : 'disabled'}>Start tournament</button>
          </div>
        `
            : `<p class="muted">Waiting for host to load a playlist and start…</p>`
        }
        ${
          pl
            ? `<div class="party-playlist-preview">
                ${pl.image ? `<img src="${esc(pl.image)}" alt="" width="72" height="72" />` : ''}
                <div>
                  <strong>${esc(pl.name)}</strong>
                  <p class="small muted">${pl.trackCount || '?'} songs · everyone in the lobby is ready when host starts</p>
                </div>
              </div>`
            : ''
        }
        ${isHost ? hostModeration(s) : ''}
      </div>
    `;
  }

  function hostModeration(s) {
    const rows = (s.players || [])
      .filter((p) => p.id !== s.you?.id)
      .map(
        (p) => `
        <div class="party-mod-row">
          ${chip(p)}
          <button type="button" class="ghost small-btn" data-kick="${esc(p.id)}">Kick</button>
          <button type="button" class="ghost small-btn" data-ban="${esc(p.id)}">Ban</button>
        </div>`
      )
      .join('');
    return rows
      ? `<div class="party-mod"><h3 class="small">Moderate</h3>${rows}</div>`
      : '';
  }

  function renderMatch(s, isHost) {
    const m = s.match;
    if (!m) return `<p>No match.</p>`;
    const vc = s.voteCount || { voted: 0, total: 0 };
    const sync = s.settings?.playMode === 'sync';
    const iVoted = Boolean(s.myVoteSide || (s.votedPlayerIds || []).includes(s.you?.id));
    const timerPhase = s.timerPhase || 'none';
    let timerHtml = '';
    if (timerPhase === 'vote30' && s.voteDeadline) {
      const leftSec = Math.max(0, Math.ceil((s.voteDeadline - Date.now()) / 1000));
      timerHtml = `<span class="party-timer-top${leftSec <= 10 ? ' is-pulse' : ''}" id="p-timer-display">${leftSec}</span>`;
    } else {
      timerHtml = `<span class="party-timer-top is-idle" id="p-timer-display"></span>`;
    }

    const volPct = Math.round(localVolume * 100);
    const npSide = s.nowPlaying?.playing ? s.nowPlaying.side : null;

    const card = (song, side) => {
      const art = song.image
        ? `<img class="cover-art-img" src="${esc(song.image)}" alt="" />`
        : `<div class="cover-art-fallback">🎵</div>`;
      const active = npSide === side || playSide === side;
      const showPlay = !sync || isHost;
      return `
        <article class="song-card party-song${active ? ' is-now-playing' : ''}" data-side-card="${side}">
          <div class="song-meta">
            <h3>${esc(song.name)}</h3>
            <p>${esc(song.artists || '')}</p>
          </div>
          <div class="cover-player">
            ${
              showPlay
                ? `<button type="button" class="cover-play-btn${active ? ' is-playing' : ''}" data-play="${side}">
                    <span class="cover-art">${art}</span>
                    <span class="cover-play-icon">${active ? '❚❚' : '▶'}</span>
                  </button>`
                : `<div class="cover-play-btn is-display-only">
                    <span class="cover-art">${art}</span>
                  </div>`
            }
          </div>
          <canvas class="party-eq" data-eq="${side}" aria-hidden="true"></canvas>
          <div class="card-action-slot volume-control party-vol-row">
            <span class="volume-icon" aria-hidden="true">🔊</span>
            <input type="range" class="volume-slider" data-party-vol min="0" max="100" step="1" value="${volPct}" aria-label="Volume" />
            <span class="volume-pct" data-party-vol-label>${volPct}%</span>
          </div>
          <button type="button" class="pick-btn" data-vote="${side}" ${
            iVoted || s.paused ? 'disabled' : ''
          }>
            <span class="pick-key">${side === 'a' ? '1' : '2'}</span>
            Vote ${side === 'a' ? 'left' : 'right'}
          </button>
        </article>`;
    };

    const noPrev =
      s.noPreviewSide === 'a' || s.noPreviewSide === 'b'
        ? `<div class="party-banner">No preview for the ${
            s.noPreviewSide === 'a' ? 'left' : 'right'
          } song — vote from the title/art or host plays the other side.</div>`
        : '';

    return `
      <div class="party-match">
        <div class="party-vote-meta">
          <strong>${esc(s.progress?.roundLabel || 'Match')}</strong>
          <span>${vc.voted}/${vc.total} voted</span>
          ${timerHtml}
        </div>
        ${noPrev}
        <div class="match-grid">
          ${card(m.a, 'a')}
          <div class="vs-badge">VS</div>
          ${card(m.b, 'b')}
        </div>
        <div class="match-actions">
          <button type="button" class="ghost" id="p-random" ${iVoted || s.paused ? 'disabled' : ''}>
            Can't decide · random 🎲
          </button>
          ${
            isHost
              ? `<button type="button" class="ghost" id="p-pause">${s.paused ? 'Unpause' : 'Pause'}</button>`
              : ''
          }
        </div>
        <p class="match-keys-hint muted small">
          ${sync ? 'Sync: host plays for everyone · ' : 'Desync: play on your device · '}
          vote anytime · 30s starts after host votes · 1 / 2 keys
        </p>
        ${isHost ? hostModeration(s) : ''}
      </div>
    `;
  }

  /** Tie-break (and rare legacy reveal) — host picks; no separate vote parade. */
  function renderTieOrLegacyReveal(s, isHost) {
    const m = s.match;
    const r = s.reveal || {};
    const list = (arr) =>
      (arr || [])
        .map((p) => chip(p, { showRandom: p.random }))
        .join('') || `<span class="muted small">—</span>`;

    return `
      <div class="card party-reveal">
        <h2>${
          r.reason === 'no_votes' ? 'No votes — host decides' : 'Tie — host decides'
        }</h2>
        <p class="muted small">${r.counts ? `${r.counts.a} – ${r.counts.b}` : ''}</p>
        <div class="party-reveal-cols">
          <div>
            <h3>${esc(m?.a?.name || 'Left')}</h3>
            <div class="party-on-art-list">${list(r.a)}</div>
          </div>
          <div>
            <h3>${esc(m?.b?.name || 'Right')}</h3>
            <div class="party-on-art-list">${list(r.b)}</div>
          </div>
        </div>
        ${
          isHost
            ? `<div class="form-actions">
                <button type="button" id="tie-a">Pick left</button>
                <button type="button" id="tie-b">Pick right</button>
              </div>`
            : `<p class="muted">Waiting for host…</p>`
        }
      </div>`;
  }

  function wireLive(s, isHost) {
    root.querySelector('#p-leave')?.addEventListener('click', leaveToMenu);
    root.querySelector('#p-copy-code')?.addEventListener('click', async () => {
      const btn = root.querySelector('#p-copy-code');
      await copyText(s.code || '', btn, 'Copied!');
    });
    root.querySelector('#p-copy-link')?.addEventListener('click', async () => {
      const btn = root.querySelector('#p-copy-link');
      const link = roomShareUrl(s.code || '');
      await copyText(link, btn, 'Link copied!');
    });
    root.querySelector('#p-end')?.addEventListener('click', () => {
      if (!confirm('End this room for everyone?')) return;
      // Host leaves live UI immediately; server notifies others
      endedByHost = true;
      send('end_room');
      hardStopAudio();
      state = null;
      screen = 'gate';
      gateMode = 'create';
      gateError = 'You ended the room.';
      statusLine = '';
      form.code = '';
      setUrlRoomParam('');
      render();
    });
    root.querySelector('#p-export')?.addEventListener('click', () => send('export'));
    root.querySelector('#copy-export')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(exportText);
        statusLine = 'Copied recovery blob.';
        render();
      } catch {
      }
    });

    // Local volume sliders (solo-style 0–100 → element.volume)
    root.querySelectorAll('[data-party-vol]').forEach((slider) => {
      slider.addEventListener('input', () => {
        setLocalVolume(Number(slider.value) / 100);
      });
    });

    if (s.phase === 'champion') {
      root.querySelector('#p-new-lobby')?.addEventListener('click', () => {
        hardStopAudio();
        lastSyncedKey = null;
        send('new_lobby');
      });
      root.querySelector('#play-party-champion')?.addEventListener('click', () => {
        if (s.settings?.playMode === 'sync') {
          if (!isHost) return;
          if (s.nowPlaying?.playing && s.nowPlaying.side === 'champion') {
            send('host_pause');
          } else {
            send('host_play', { side: 'champion' });
          }
          return;
        }
        if (playSide === 'champion' && audioEl && !audioEl.paused) {
          hardStopAudio();
          render();
          return;
        }
        if (s.champion) playPreview(s.champion, 'champion', { continuous: true });
      });
      wirePartyBracketTabs(root.querySelector('#party-bracket-explorer'));
      if (s.nowPlaying) applyNowPlaying(s.nowPlaying);
      else if (s.champion) {
        playPreview(s.champion, 'champion', { quiet: true, continuous: true });
      }
    }

    if (isHost && s.phase === 'lobby') {
      // Prefer remembered play mode
      try {
        const pref = localStorage.getItem(PLAYMODE_PREF_KEY);
        if (pref === 'sync' || pref === 'desync') {
          if (s.settings?.playMode !== pref) {
            send('settings', { settings: { playMode: pref } });
          }
        }
      } catch {
      }
      root.querySelector('#p-seed')?.addEventListener('change', (e) => {
        send('settings', { settings: { seeding: e.target.value } });
      });
      root.querySelector('#p-playmode')?.addEventListener('change', (e) => {
        const mode = e.target.value;
        try {
          localStorage.setItem(PLAYMODE_PREF_KEY, mode);
        } catch {
        }
        send('settings', { settings: { playMode: mode } });
      });
      root.querySelector('#p-load')?.addEventListener('click', () => {
        const url = root.querySelector('#p-url')?.value?.trim() || '';
        form.playlistUrl = url;
        statusLine = 'Loading playlist…';
        send('load_playlist', { url });
      });
      root.querySelector('#p-start')?.addEventListener('click', () => send('start'));
    }

    root.querySelectorAll('[data-kick]').forEach((btn) => {
      btn.addEventListener('click', () => send('kick', { targetId: btn.getAttribute('data-kick') }));
    });
    root.querySelectorAll('[data-ban]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (confirm('Ban this player from rejoining this room?')) {
          send('ban', { targetId: btn.getAttribute('data-ban') });
        }
      });
    });

    if (s.phase === 'match') {
      const sync = s.settings?.playMode === 'sync';
      root.querySelectorAll('[data-play]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const side = btn.getAttribute('data-play');
          if (sync) {
            if (!isHost) return;
            if (s.nowPlaying?.playing && s.nowPlaying.side === side) {
              send('host_pause');
            } else {
              send('host_play', { side });
            }
            return;
          }
          const song = side === 'a' ? s.match?.a : s.match?.b;
          if (playSide === side && audioEl && !audioEl.paused) {
            hardStopAudio();
            render();
            return;
          }
          playPreview(song, side);
        });
      });
      root.querySelectorAll('[data-vote]').forEach((btn) => {
        btn.addEventListener('click', () => {
          send('vote', { side: btn.getAttribute('data-vote') });
        });
      });
      root.querySelector('#p-random')?.addEventListener('click', () => {
        send('vote_random');
      });
      root.querySelector('#p-pause')?.addEventListener('click', () => {
        send(s.paused ? 'unpause' : 'pause');
      });

      // 30s top countdown after host votes (pulse under 10s)
      if (s.timerPhase === 'vote30' && s.voteDeadline && !s.paused) {
        const el = root.querySelector('#p-timer-display');
        const epoch = uiEpoch;
        const tick = () => {
          if (destroyed || epoch !== uiEpoch) return;
          if (!el || !el.isConnected || !state || state.phase !== 'match') return;
          if (state.timerPhase !== 'vote30' || !state.voteDeadline) {
            el.textContent = '';
            return;
          }
          const sec = Math.max(0, Math.ceil((state.voteDeadline - Date.now()) / 1000));
          el.textContent = String(sec);
          el.classList.toggle('is-pulse', sec <= 10 && sec > 0);
          if (sec > 0) setTimeout(tick, 200);
        };
        tick();
      }

      if (s.nowPlaying) applyNowPlaying(s.nowPlaying);
      if (playSide) startEq(playSide);
    }

    if (s.phase === 'tie_break' && isHost) {
      root.querySelector('#tie-a')?.addEventListener('click', () => send('tie_break', { side: 'a' }));
      root.querySelector('#tie-b')?.addEventListener('click', () => send('tie_break', { side: 'b' }));
    }

    // Abstain labels only on reveal-style moments (winner beat chips already voters-only)
    if (s.phase === 'winner' && s.winnerBeat) {
      root.querySelector('#p-skip-winner')?.addEventListener('click', () => send('skip_winner'));
      if (s.nowPlaying) applyNowPlaying(s.nowPlaying);
      prefetchUpcomingFromState(s);
    }
  }

  function onKey(e) {
    if (screen !== 'live' || !state || state.phase !== 'match' || state.paused) return;
    const tag = e.target?.tagName;
    // Don't steal keys while typing in chat or other fields
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target?.id === 'party-chat-input') return;
    if ((state.votedPlayerIds || []).includes(state.you?.id)) return;
    if (e.key === '1') {
      e.preventDefault();
      send('vote', { side: 'a' });
    } else if (e.key === '2') {
      e.preventDefault();
      send('vote', { side: 'b' });
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      send('vote_random');
    }
  }

  window.addEventListener('keydown', onKey);

  function render() {
    if (destroyed) return;
    // Invalidate vote-timer chains and stale EQ loops for this paint
    uiEpoch += 1;
    // Tear down cropper DOM if we're redrawing (rebuilt below if still open)
    document.getElementById('pfp-crop-overlay')?.remove();
    if (screen === 'gate') renderGate();
    else renderLive();
    if (cropper) renderCropperOverlay();
  }

  render();

  return {
    destroy() {
      destroyed = true;
      uiEpoch += 1;
      playGen += 1;
      connectEpoch += 1;
      window.removeEventListener('keydown', onKey);
      if (onPfpPaste) {
        document.removeEventListener('paste', onPfpPaste);
        onPfpPaste = null;
      }
      document.getElementById('pfp-crop-overlay')?.remove();
      cropper = null;
      cropDrag = null;
      chatMessages = [];
      disposePartyAudio();
      try {
        ws?.close();
      } catch {
      }
      ws = null;
      state = null;
    },
  };
}
