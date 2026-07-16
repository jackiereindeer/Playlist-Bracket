/**
 * One multiplayer room. All authority lives here — clients just display state.
 * Spotify-only playlists for party v1.
 */
import crypto from 'crypto';
import {
  createTournament,
  pickWinner,
  currentMatch,
  progress,
} from '../../src/tournament.js';
import {
  COLORS,
  AVATARS,
  DEFAULT_VOTE_SECONDS,
  HOST_BACKUP_SECONDS,
  MAX_NAME_LEN,
  MAX_PLAYERS,
  PHASE,
  IDLE_MS,
} from './constants.js';

function rid() {
  return crypto.randomBytes(8).toString('hex');
}

function safeName(raw) {
  const s = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN);
  return s || 'Player';
}

function colorOk(id) {
  return COLORS.some((c) => c.id === id);
}

function avatarOk(id) {
  return AVATARS.some((a) => a.id === id);
}

/** Custom PFP: only small data-URL images (client already resizes). */
const MAX_PFP_CHARS = 120_000; // ~90KB base64 — keeps WS snapshots light

function sanitizePfp(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s.startsWith('data:image/')) return null;
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/i.test(s)) return null;
  if (s.length > MAX_PFP_CHARS) return null;
  return s;
}

function slimSong(s) {
  if (!s || !s.id) return null;
  return {
    id: s.id,
    name: s.name || 'Unknown',
    artists: s.artists || '',
    image: s.image || null,
    source: s.source || 'spotify',
    spotifyUrl: s.spotifyUrl || null,
  };
}

export class Room {
  /**
   * @param {string} code
   * @param {{ broadcast: (room: Room) => void }} hub
   */
  constructor(code, hub) {
    this.code = code;
    this.hub = hub;
    this.createdAt = Date.now();
    this.lastActive = Date.now();
    this.phase = PHASE.LOBBY;
    this.paused = false;
    this.locked = false; // true after Start until champion lobby
    this.settings = {
      seeding: 'order', // order | shuffle
      playMode: 'desync', // desync | sync
      voteSeconds: DEFAULT_VOTE_SECONDS,
      backupSeconds: HOST_BACKUP_SECONDS,
    };
    /** @type {Map<string, object>} */
    this.players = new Map();
    /** @type {Set<string>} session tokens banned from this room */
    this.bans = new Set();
    this.playlistMeta = null;
    this.playlistUrl = '';
    this.tournament = null;
    /** @type {Map<string, { side: 'a'|'b', random: boolean }>} */
    this.votes = new Map();
    /** @type {number|null} epoch ms when 30s (or remaining) vote window ends */
    this.voteDeadline = null;
    /** @type {number|null} epoch ms when 300s host-backup ends (before host votes) */
    this.backupDeadline = null;
    this.voteTimer = null;
    this.backupTimer = null;
    /** @type {'none'|'waiting_host'|'vote30'|'backup300'} */
    this.timerPhase = 'none';
    this.hostHasVoted = false;
    /** Pause: freeze remaining ms */
    this.pausedVoteRemainingMs = null;
    this.pausedBackupRemainingMs = null;
    /**
     * Sync room playback (host-driven).
     * @type {{ side: 'a'|'b', trackId: string, song: object, playing: boolean }|null}
     */
    this.nowPlaying = null;
    this.noPreviewSide = null; // 'a' | 'b' | null — room-wide banner
    this.reveal = null;
    this.winnerBeat = null;
    this.error = '';
    this.soloLike = false;
    this.abstentions = []; // public player chips for reveal
    /** Chat kept server-side for memory cap only — late joiners do NOT receive history. */
    this.chatLog = [];
  }

  /**
   * In-room chat. Live broadcast only (3B: only messages after you joined).
   * Everyone connected may chat (2A).
   */
  postChat(playerId, rawText) {
    this.touch();
    const p = this.players.get(playerId);
    if (!p?.connected || p.banned) {
      const err = new Error('You cannot chat.');
      err.code = 'NO_CHAT';
      throw err;
    }
    const text = String(rawText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!text) {
      const err = new Error('Empty message.');
      err.code = 'EMPTY';
      throw err;
    }
    const msg = {
      id: rid(),
      at: Date.now(),
      playerId: p.id,
      displayName: p.displayName,
      color: p.color,
      avatar: p.avatar,
      pfp: p.pfp || null,
      text,
    };
    this.chatLog.push(msg);
    if (this.chatLog.length > 200) {
      this.chatLog.splice(0, this.chatLog.length - 200);
    }
    this.hub.sendToRoom(this, 'chat', { message: msg });
    return msg;
  }

  touch() {
    this.lastActive = Date.now();
  }

  isIdle() {
    return Date.now() - this.lastActive > IDLE_MS;
  }

  getPlayer(id) {
    return this.players.get(id) || null;
  }

  host() {
    for (const p of this.players.values()) {
      if (p.isHost && p.connected) return p;
    }
    for (const p of this.players.values()) {
      if (p.isHost) return p;
    }
    return null;
  }

  connectedVoters() {
    return [...this.players.values()].filter(
      (p) => p.connected && !p.banned && !this.bans.has(p.sessionToken)
    );
  }

  publicPlayer(p) {
    return {
      id: p.id,
      displayName: p.displayName,
      color: p.color,
      avatar: p.avatar,
      pfp: p.pfp || null,
      isHost: p.isHost,
      connected: p.connected,
      joinedAt: p.joinedAt,
    };
  }

  /** Snapshot every client receives. */
  snapshot(forPlayerId = null) {
    const me = forPlayerId ? this.players.get(forPlayerId) : null;
    const match = this.tournament ? currentMatch(this.tournament) : null;
    const prog = this.tournament ? progress(this.tournament) : null;

    const votedIds = [...this.votes.keys()];
    const voters = this.connectedVoters();
    const voteCount = {
      voted: voters.filter((p) => this.votes.has(p.id)).length,
      total: voters.length,
    };

    // Never leak which side someone picked until reveal/winner/tie
    const showSides =
      this.phase === PHASE.REVEAL ||
      this.phase === PHASE.TIE_BREAK ||
      this.phase === PHASE.WINNER;

    let myVote = null;
    if (me && this.votes.has(me.id)) {
      const v = this.votes.get(me.id);
      myVote = { side: v.side, random: v.random };
    }

    return {
      code: this.code,
      phase: this.phase,
      paused: this.paused,
      locked: this.locked,
      settings: { ...this.settings },
      players: [...this.players.values()]
        .filter((p) => !p.banned)
        .map((p) => this.publicPlayer(p))
        .sort((a, b) => a.joinedAt - b.joinedAt),
      playlist: this.playlistMeta,
      playlistUrl: this.playlistUrl || '',
      error: this.error || '',
      match: match
        ? {
            a: slimSong(match.a),
            b: slimSong(match.b),
            region: match.region || null,
          }
        : null,
      progress: prog
        ? {
            roundLabel: prog.roundLabel,
            matchInRound: prog.matchInRound,
            matchesInRound: prog.matchesInRound,
            remaining: this.tournament?.remaining,
          }
        : null,
      voteCount,
      votedPlayerIds: votedIds,
      myVote: showSides || this.phase === PHASE.MATCH ? myVote : myVote,
      myVoteSide:
        me && this.votes.has(me.id) ? this.votes.get(me.id).side : null,
      myVotedRandom:
        me && this.votes.has(me.id) ? this.votes.get(me.id).random : false,
      voteDeadline: this.voteDeadline,
      backupDeadline: this.backupDeadline,
      timerPhase: this.timerPhase,
      hostHasVoted: this.hostHasVoted,
      nowPlaying: this.nowPlaying
        ? {
            side: this.nowPlaying.side,
            trackId: this.nowPlaying.trackId,
            song: this.nowPlaying.song ? slimSong(this.nowPlaying.song) : null,
            playing: Boolean(this.nowPlaying.playing),
            stop: Boolean(this.nowPlaying.stop),
          }
        : null,
      noPreviewSide: this.noPreviewSide,
      reveal: this.reveal,
      abstentions: this.abstentions || [],
      winnerBeat: this.winnerBeat
        ? {
            song: slimSong(this.winnerBeat.song),
            loserSong: slimSong(this.winnerBeat.loserSong),
            voters: this.winnerBeat.voters || [],
            losers: this.winnerBeat.losers || [],
            winnerSide: this.winnerBeat.winnerSide,
            abstentions: this.winnerBeat.abstentions || this.abstentions || [],
          }
        : null,
      champion: this.tournament?.champion
        ? slimSong(this.tournament.champion)
        : null,
      history:
        this.phase === PHASE.CHAMPION && this.tournament
          ? (this.tournament.history || []).map((h) => ({
              round: h.round,
              region: h.region,
              winnerId: h.winnerId,
              loserId: h.loserId,
              a: slimSong(h.a),
              b: slimSong(h.b),
            }))
          : null,
      results:
        this.phase === PHASE.CHAMPION && this.tournament
          ? {
              initialCount: this.tournament.initialCount || 0,
              matchups: Array.isArray(this.tournament.history)
                ? this.tournament.history.length
                : 0,
              playlistName: this.playlistMeta?.name || this.tournament.playlist?.name || '',
              playlistImage: this.playlistMeta?.image || this.tournament.playlist?.image || null,
            }
          : null,
      you: me
        ? {
            id: me.id,
            isHost: me.isHost,
            sessionToken: me.sessionToken,
            displayName: me.displayName,
            color: me.color,
            avatar: me.avatar,
            pfp: me.pfp || null,
          }
        : null,
      exportHint:
        'Host can use Export recovery if the room breaks — paste into a new room later.',
    };
  }

  broadcast() {
    this.hub.broadcast(this);
  }

  addPlayer({ displayName, color, avatar, pfp, sessionToken, preferHost }) {
    this.touch();
    let resumeToken = sessionToken || null;
    const safePfp = sanitizePfp(pfp);

    if (resumeToken && this.bans.has(resumeToken)) {
      const err = new Error('You are banned from this room.');
      err.code = 'BANNED';
      throw err;
    }

    // Rejoin by session token — only if that seat is free (not already online).
    // If the token is already connected (another tab), mint a NEW player instead
    // of hijacking the live seat (that bug made rooms look capped at 1–2).
    if (resumeToken) {
      for (const p of this.players.values()) {
        if (p.sessionToken === resumeToken && !p.banned) {
          const alreadyLive =
            p.connected && p.ws && p.ws.readyState === 1; /* WebSocket.OPEN */
          if (alreadyLive) {
            resumeToken = null;
            break;
          }
          p.connected = true;
          p.ws = null; // set by hub
          if (displayName) p.displayName = safeName(displayName);
          if (colorOk(color)) p.color = color;
          if (avatarOk(avatar)) p.avatar = avatar;
          p.pfp = safePfp;
          return p;
        }
      }
    }

    // New players only in open lobby. Champion results = wait for host "New lobby".
    // (Existing seats still rejoin above via session token.)
    if (this.phase !== PHASE.LOBBY) {
      const err = new Error(
        this.phase === PHASE.CHAMPION
          ? 'Tournament finished — wait for the host to open a new lobby.'
          : 'Game already started — wait for the next lobby after this tournament.'
      );
      err.code = 'LOCKED';
      throw err;
    }

    if (this.players.size >= MAX_PLAYERS) {
      const err = new Error('Room is full.');
      err.code = 'FULL';
      throw err;
    }

    const id = rid();
    const token = resumeToken || rid() + rid();
    const isFirst = this.players.size === 0;
    const player = {
      id,
      displayName: safeName(displayName),
      color: colorOk(color) ? color : COLORS[0].id,
      avatar: avatarOk(avatar) ? avatar : AVATARS[0].id,
      pfp: safePfp,
      sessionToken: token,
      isHost: isFirst || Boolean(preferHost && !this.host()),
      connected: true,
      banned: false,
      joinedAt: Date.now(),
      ws: null,
    };
    this.players.set(id, player);
    return player;
  }

  setDisconnected(playerId) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.connected = false;
    p.ws = null;
    this.touch();

    if (p.isHost) {
      this.transferHost();
    }

    // If mid-vote, re-check whether all remaining connected have voted
    if (this.phase === PHASE.MATCH && !this.paused) {
      this.maybeFinishVoting();
    }
    this.broadcast();
  }

  transferHost() {
    const candidates = [...this.players.values()]
      .filter((p) => p.connected && !p.banned)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    for (const p of this.players.values()) p.isHost = false;
    if (candidates[0]) {
      candidates[0].isHost = true;
    }
  }

  assertHost(playerId) {
    const p = this.players.get(playerId);
    if (!p?.isHost) {
      const err = new Error('Only the host can do that.');
      err.code = 'NOT_HOST';
      throw err;
    }
    return p;
  }

  updateSettings(playerId, partial) {
    this.assertHost(playerId);
    this.touch();
    if (this.locked && this.phase !== PHASE.LOBBY && this.phase !== PHASE.CHAMPION) {
      const err = new Error('Cannot change settings mid-tournament.');
      err.code = 'LOCKED';
      throw err;
    }
    if (partial.seeding === 'order' || partial.seeding === 'shuffle') {
      this.settings.seeding = partial.seeding;
    }
    if (partial.playMode === 'desync' || partial.playMode === 'sync') {
      // Sync is accepted but clients treat as desync until implemented
      this.settings.playMode = partial.playMode;
    }
    if (Number.isFinite(partial.voteSeconds)) {
      const n = Math.round(partial.voteSeconds);
      this.settings.voteSeconds = Math.min(600, Math.max(30, n));
    }
    this.broadcast();
  }

  /**
   * Host loaded playlist JSON from API (server-side fetch preferred via hub).
   */
  setPlaylist(playerId, playlist, url) {
    this.assertHost(playerId);
    this.touch();
    this.error = '';

    if (!playlist?.tracks || playlist.tracks.length < 2) {
      this.error = 'Need at least 2 playable songs.';
      this.playlistMeta = null;
      this.playlistUrl = '';
      this.broadcast();
      return;
    }

    // Party v1: Spotify only
    const source = playlist.source || 'spotify';
    if (source === 'youtube' || playlist.tracks.some((t) => t.source === 'youtube')) {
      this.error = 'Party mode is Spotify-only for now. Solo still supports YouTube.';
      this.playlistMeta = null;
      this.playlistUrl = '';
      this.broadcast();
      return;
    }

    this.playlistUrl = String(url || '').slice(0, 500);
    this.playlistMeta = {
      id: playlist.id,
      name: playlist.name || 'Playlist',
      image: playlist.image || null,
      trackCount: playlist.tracks.length,
      source: 'spotify',
    };
    this._rawTracks = playlist.tracks.map(slimSong).filter(Boolean);
    this.phase = PHASE.LOBBY;
    this.locked = false;
    this.tournament = null;
    this.votes.clear();
    this.clearVoteTimer();
    this.reveal = null;
    this.winnerBeat = null;
    this.broadcast();
  }

  startTournament(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (!this._rawTracks || this._rawTracks.length < 2) {
      const err = new Error('Load a Spotify playlist first.');
      err.code = 'NO_PLAYLIST';
      throw err;
    }

    const voters = this.connectedVoters();
    if (voters.length < 1) {
      const err = new Error('Need at least one connected player.');
      err.code = 'NO_PLAYERS';
      throw err;
    }

    this.soloLike = voters.length === 1;
    this.tournament = createTournament(
      {
        id: this.playlistMeta?.id,
        name: this.playlistMeta?.name,
        image: this.playlistMeta?.image,
        source: 'spotify',
      },
      this._rawTracks,
      this.settings.seeding
    );
    this.locked = true;
    this.paused = false;
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.error = '';
    this.beginMatchPhase();
    this.broadcast();
  }

  beginMatchPhase() {
    this.clearVoteTimer();
    // Clear room playback; clients stop celebration audio on winner→match transition
    this.nowPlaying = null;
    this.noPreviewSide = null;
    this.hostHasVoted = false;
    this.abstentions = [];
    this.pausedVoteRemainingMs = null;
    this.pausedBackupRemainingMs = null;

    if (!this.tournament || this.tournament.finished) {
      this.phase = PHASE.CHAMPION;
      this.locked = true;
      this.timerPhase = 'none';
      return;
    }
    const m = currentMatch(this.tournament);
    if (!m) {
      this.phase = PHASE.CHAMPION;
      this.locked = true;
      this.timerPhase = 'none';
      return;
    }
    this.phase = PHASE.MATCH;
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    // No 30s yet — wait for host vote. 300s backup if host never votes.
    this.timerPhase = 'waiting_host';
    this.voteDeadline = null;
    const backupSec = this.settings.backupSeconds || HOST_BACKUP_SECONDS;
    this.backupDeadline = Date.now() + backupSec * 1000;
    this.backupTimer = setTimeout(() => this.onBackupTimeout(), backupSec * 1000);
  }

  clearVoteTimer() {
    if (this.voteTimer) {
      clearTimeout(this.voteTimer);
      this.voteTimer = null;
    }
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    this.voteDeadline = null;
    this.backupDeadline = null;
    this.timerPhase = 'none';
    if (this._winnerAdvanceTimer) {
      clearTimeout(this._winnerAdvanceTimer);
      this._winnerAdvanceTimer = null;
    }
  }

  /** Start the 30s window after the host locks their vote. */
  startHostVoteWindow() {
    if (this.voteTimer) {
      clearTimeout(this.voteTimer);
      this.voteTimer = null;
    }
    if (this.backupTimer) {
      clearTimeout(this.backupTimer);
      this.backupTimer = null;
    }
    this.backupDeadline = null;
    this.pausedBackupRemainingMs = null;
    const secs = this.settings.voteSeconds || DEFAULT_VOTE_SECONDS;
    this.timerPhase = 'vote30';
    this.voteDeadline = Date.now() + secs * 1000;
    this.voteTimer = setTimeout(() => this.onVoteTimeout(), secs * 1000);
  }

  castVote(playerId, side, { random = false } = {}) {
    this.touch();
    if (this.paused) {
      const err = new Error('Voting is paused.');
      err.code = 'PAUSED';
      throw err;
    }
    if (this.phase !== PHASE.MATCH) {
      const err = new Error('Not accepting votes right now.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    const p = this.players.get(playerId);
    if (!p?.connected || p.banned) {
      const err = new Error('You cannot vote.');
      err.code = 'NO_VOTE';
      throw err;
    }
    if (this.votes.has(playerId)) {
      const err = new Error('Vote already locked.');
      err.code = 'LOCKED_VOTE';
      throw err;
    }
    if (side !== 'a' && side !== 'b') {
      const err = new Error('Invalid side.');
      err.code = 'BAD_SIDE';
      throw err;
    }
    let finalSide = side;
    let wasRandom = Boolean(random);
    if (wasRandom) {
      finalSide = Math.random() < 0.5 ? 'a' : 'b';
    }
    this.votes.set(playerId, { side: finalSide, random: wasRandom });

    // Host's first vote starts the 30s countdown for everyone else
    if (p.isHost && !this.hostHasVoted) {
      this.hostHasVoted = true;
      this.startHostVoteWindow();
    }

    this.maybeFinishVoting();
    this.broadcast();
  }

  maybeFinishVoting() {
    if (this.phase !== PHASE.MATCH || this.paused) return;
    const voters = this.connectedVoters();
    if (voters.length === 0) return;
    const allIn = voters.every((x) => this.votes.has(x.id));
    if (allIn) {
      this.finishVoting();
    }
  }

  onVoteTimeout() {
    this.voteTimer = null;
    if (this.phase !== PHASE.MATCH || this.paused) return;
    this.finishVoting();
  }

  /** Host never voted within 300s → random match winner. */
  onBackupTimeout() {
    this.backupTimer = null;
    if (this.phase !== PHASE.MATCH || this.paused) return;
    if (this.hostHasVoted) return;
    const side = Math.random() < 0.5 ? 'a' : 'b';
    this.clearVoteTimer();
    this.nowPlaying = null;
    this.applyWinner(side, [], [], { a: 0, b: 0, randomBackup: true });
  }

  /** Removed by design — no skip timer. */
  skipTimer() {
    /* no-op */
  }

  finishVoting() {
    this.clearVoteTimer();
    this.nowPlaying = null;
    this.noPreviewSide = null;
    const voters = this.connectedVoters();
    const tally = { a: 0, b: 0 };
    const listA = [];
    const listB = [];
    const abstentions = [];

    for (const p of voters) {
      const v = this.votes.get(p.id);
      const chip = {
        id: p.id,
        displayName: p.displayName,
        color: p.color,
        avatar: p.avatar,
        pfp: p.pfp || null,
      };
      if (!v) {
        abstentions.push({ ...chip, abstain: true });
        continue;
      }
      if (v.side === 'a') {
        tally.a += 1;
        listA.push({ ...chip, random: v.random });
      } else {
        tally.b += 1;
        listB.push({ ...chip, random: v.random });
      }
    }
    this.abstentions = abstentions;

    const match = currentMatch(this.tournament);
    if (!match) {
      this.phase = PHASE.CHAMPION;
      this.locked = true;
      return;
    }

    if (tally.a === 0 && tally.b === 0) {
      // No real votes — host must pick (unless we already used random backup)
      this.phase = PHASE.TIE_BREAK;
      this.reveal = {
        a: [],
        b: [],
        counts: tally,
        reason: 'no_votes',
        needsHost: true,
        abstentions,
      };
      this.broadcast();
      return;
    }

    if (tally.a === tally.b) {
      this.phase = PHASE.TIE_BREAK;
      this.reveal = {
        a: listA,
        b: listB,
        counts: tally,
        reason: 'tie',
        needsHost: true,
        abstentions,
      };
      this.broadcast();
      return;
    }

    const winnerSide = tally.a > tally.b ? 'a' : 'b';
    this.applyWinner(winnerSide, listA, listB, tally);
  }

  applyWinner(winnerSide, listA, listB, tally) {
    const match = currentMatch(this.tournament);
    if (!match) return;

    const winnerSong = winnerSide === 'a' ? match.a : match.b;
    const loserSong = winnerSide === 'a' ? match.b : match.a;
    const voters = winnerSide === 'a' ? listA || [] : listB || [];
    const losers = winnerSide === 'a' ? listB || [] : listA || [];

    this.reveal = {
      a: listA || [],
      b: listB || [],
      counts: tally || { a: 0, b: 0 },
      winnerSide,
      reason: 'majority',
      needsHost: false,
    };
    // Celebration: winner (large) + loser (small/grey) + voter chips with custom PFPs
    this.winnerBeat = {
      song: winnerSong,
      loserSong,
      voters,
      losers,
      winnerSide,
      abstentions: this.abstentions || [],
    };
    this.phase = PHASE.WINNER;
    this.nowPlaying = {
      side: 'winner',
      trackId: winnerSong.id,
      song: winnerSong,
      playing: true,
    };
    this.broadcast();

    // Match-to-match: ~4.5s then next. Final match advances to champion (audio continues).
    if (this._winnerAdvanceTimer) {
      clearTimeout(this._winnerAdvanceTimer);
      this._winnerAdvanceTimer = null;
    }
    this._winnerAdvanceTimer = setTimeout(() => {
      this._winnerAdvanceTimer = null;
      if (this.phase !== PHASE.WINNER) return;
      this.advanceWithSide(winnerSide);
    }, 4500);
  }

  hostBreakTie(playerId, side) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.TIE_BREAK) {
      const err = new Error('Not in a tie-break.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    if (side !== 'a' && side !== 'b') {
      const err = new Error('Pick left or right.');
      err.code = 'BAD_SIDE';
      throw err;
    }
    const listA = this.reveal?.a || [];
    const listB = this.reveal?.b || [];
    const tally = this.reveal?.counts || { a: 0, b: 0 };
    this.applyWinner(side, listA, listB, tally);
  }

  advanceWithSide(side) {
    if (!this.tournament) return;
    if (this._winnerAdvanceTimer) {
      clearTimeout(this._winnerAdvanceTimer);
      this._winnerAdvanceTimer = null;
    }
    this.tournament = pickWinner(this.tournament, side);
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.nowPlaying = null;
    this.noPreviewSide = null;

    if (this.tournament.finished) {
      // Stay on champion results — continuous play of champion for everyone
      this.phase = PHASE.CHAMPION;
      this.locked = true;
      this.paused = false;
      const champ = this.tournament.champion;
      if (champ?.id) {
        this.nowPlaying = {
          side: 'champion',
          trackId: champ.id,
          song: champ,
          playing: true,
        };
      }
      this.clearVoteTimer();
      this.broadcast();
      return;
    }
    this.beginMatchPhase();
    this.broadcast();
  }

  /**
   * Host leaves the post-tournament results screen and reopens the lobby
   * for a new playlist (same room code / players).
   */
  newLobby(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.CHAMPION) {
      const err = new Error('Only available after a tournament ends.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    this.phase = PHASE.LOBBY;
    this.locked = false;
    this.paused = false;
    this.tournament = null;
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.nowPlaying = null;
    this.noPreviewSide = null;
    this.abstentions = [];
    this.error = '';
    // Keep last playlist meta as a hint; host can load a new link
    this.clearVoteTimer();
    this.broadcast();
  }

  /** Host can skip the winner celebration if audio/UI is stuck. */
  skipWinner(playerId) {
    this.assertHost(playerId);
    if (this.phase !== PHASE.WINNER) return;
    const side = this.winnerBeat?.winnerSide || this.reveal?.winnerSide;
    if (side !== 'a' && side !== 'b') return;
    this.advanceWithSide(side);
  }

  setPaused(playerId, paused) {
    this.assertHost(playerId);
    this.touch();
    const want = Boolean(paused);
    if (want === this.paused) {
      this.broadcast();
      return;
    }

    if (want) {
      // Freeze remaining time
      if (this.voteTimer && this.voteDeadline) {
        this.pausedVoteRemainingMs = Math.max(0, this.voteDeadline - Date.now());
        clearTimeout(this.voteTimer);
        this.voteTimer = null;
      }
      if (this.backupTimer && this.backupDeadline) {
        this.pausedBackupRemainingMs = Math.max(0, this.backupDeadline - Date.now());
        clearTimeout(this.backupTimer);
        this.backupTimer = null;
      }
      if (this.nowPlaying) {
        this.nowPlaying = { ...this.nowPlaying, playing: false };
      }
      this.paused = true;
    } else {
      this.paused = false;
      if (this.pausedVoteRemainingMs != null && this.phase === PHASE.MATCH) {
        const ms = this.pausedVoteRemainingMs;
        this.pausedVoteRemainingMs = null;
        this.voteDeadline = Date.now() + ms;
        this.timerPhase = 'vote30';
        this.voteTimer = setTimeout(() => this.onVoteTimeout(), ms);
      } else if (this.pausedBackupRemainingMs != null && this.phase === PHASE.MATCH) {
        const ms = this.pausedBackupRemainingMs;
        this.pausedBackupRemainingMs = null;
        this.backupDeadline = Date.now() + ms;
        this.timerPhase = 'waiting_host';
        this.backupTimer = setTimeout(() => this.onBackupTimeout(), ms);
      }
    }
    this.broadcast();
  }

  /**
   * Host starts (or switches to) a side for the whole room (Sync mode).
   * Desync clients ignore nowPlaying and use local play.
   */
  hostPlay(playerId, side) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.MATCH && this.phase !== PHASE.WINNER && this.phase !== PHASE.CHAMPION) {
      const err = new Error('Nothing to play right now.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    if (side !== 'a' && side !== 'b' && side !== 'champion' && side !== 'winner') {
      const err = new Error('Bad side.');
      err.code = 'BAD_SIDE';
      throw err;
    }

    let song = null;
    let playSide = side;
    if (side === 'a' || side === 'b') {
      const m = currentMatch(this.tournament);
      if (!m) {
        const err = new Error('No match.');
        err.code = 'NO_MATCH';
        throw err;
      }
      song = side === 'a' ? m.a : m.b;
    } else if (side === 'winner' && this.winnerBeat?.song) {
      song = this.winnerBeat.song;
      playSide = 'winner';
    } else if (side === 'champion' && this.tournament?.champion) {
      song = this.tournament.champion;
      playSide = 'champion';
    }
    if (!song?.id) {
      const err = new Error('No track.');
      err.code = 'NO_TRACK';
      throw err;
    }

    this.noPreviewSide = null;
    this.nowPlaying = {
      side: playSide,
      trackId: song.id,
      song,
      playing: true,
    };
    this.broadcast();
  }

  hostPause(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (this.nowPlaying) {
      this.nowPlaying = { ...this.nowPlaying, playing: false };
    }
    this.broadcast();
  }

  /** Client reports no preview for a side so everyone sees the banner. */
  reportNoPreview(playerId, side) {
    const p = this.players.get(playerId);
    if (!p?.isHost) return;
    if (side === 'a' || side === 'b') {
      this.noPreviewSide = side;
      this.broadcast();
    }
  }

  kick(playerId, targetId) {
    this.assertHost(playerId);
    this.touch();
    if (playerId === targetId) {
      const err = new Error('Cannot kick yourself.');
      err.code = 'BAD_TARGET';
      throw err;
    }
    const t = this.players.get(targetId);
    if (!t) return;
    t.connected = false;
    try {
      t.ws?.close();
    } catch {
    }
    t.ws = null;
    // Allow rejoin with new identity — drop player record so they look new
    this.players.delete(targetId);
    this.votes.delete(targetId);
    this.maybeFinishVoting();
    this.broadcast();
  }

  ban(playerId, targetId) {
    this.assertHost(playerId);
    this.touch();
    if (playerId === targetId) {
      const err = new Error('Cannot ban yourself.');
      err.code = 'BAD_TARGET';
      throw err;
    }
    const t = this.players.get(targetId);
    if (!t) return;
    this.bans.add(t.sessionToken);
    t.banned = true;
    t.connected = false;
    try {
      t.ws?.close();
    } catch {
    }
    this.players.delete(targetId);
    this.votes.delete(targetId);
    this.maybeFinishVoting();
    this.broadcast();
  }

  endRoom() {
    this.clearVoteTimer();
    this.nowPlaying = null;
    // Close after hub has already sent "ended" to each client
    for (const p of this.players.values()) {
      try {
        p.ws?.close(1000, 'room_ended');
      } catch {
      }
      p.ws = null;
      p.connected = false;
    }
    this.players.clear();
  }

  /** Recovery export for host — continue later in a new room (best-effort). */
  exportRecovery(playerId) {
    this.assertHost(playerId);
    const payload = {
      v: 1,
      code: this.code,
      exportedAt: Date.now(),
      settings: this.settings,
      playlistUrl: this.playlistUrl,
      playlistMeta: this.playlistMeta,
      phase: this.phase,
      tournament: this.tournament,
      notes:
        'Recovery snapshot. Create a new room and use Import recovery (if available) or restart with the same playlist.',
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  destroy() {
    this.clearVoteTimer();
  }
}
