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
  peekNextMatch,
} from '../../src/tournament.js';
import {
  COLORS,
  AVATARS,
  DEFAULT_VOTE_SECONDS,
  HOST_BACKUP_SECONDS,
  MAX_NAME_LEN,
  MAX_PLAYERS,
  MAX_PLAYERS_GROUP_RATE,
  PHASE,
  GAME_MODE,
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
  const source =
    s.source ||
    (s.youtubeId || s.youtubeUrl ? 'youtube' : 'spotify');
  return {
    id: s.id,
    name: s.name || 'Unknown',
    artists: s.artists || '',
    image: s.image || null,
    source,
    spotifyUrl: s.spotifyUrl || null,
    youtubeUrl: s.youtubeUrl || null,
    youtubeId: s.youtubeId || (source === 'youtube' ? s.id : null),
    embedUrl: s.embedUrl || null,
  };
}

function rosterSourceLabel(tracks) {
  if (!tracks?.length) return 'mixed';
  const sources = new Set(tracks.map((t) => t.source || 'spotify'));
  if (sources.size === 1) return [...sources][0];
  return 'mixed';
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
      /** bracket = 1v1 tournament · group_rate = rate songs together */
      gameMode: GAME_MODE.BRACKET,
      seeding: 'order', // order | shuffle
      playMode: 'desync', // desync | sync (bracket); group rate is always desync
      voteSeconds: DEFAULT_VOTE_SECONDS,
      backupSeconds: HOST_BACKUP_SECONDS,
      /** If true, any connected player can add songs by link (host still curates). */
      allowPartyAddSongs: false,
    };
    // ── Group Rate session (null / cleared in lobby) ──
    /** @type {object[]|null} locked track list */
    this.rateTracks = null;
    this.rateIndex = 0;
    /** @type {Set<string>} rater player ids (snapshot at start; DC removes) */
    this.rateRaterIds = new Set();
    /**
     * Current song lock-ins: playerId → { score, displayName, color, avatar, pfp }
     * Kept if they DC after locking so their score still ranks.
     */
    this.rateSongScores = new Map();
    /**
     * Finished songs: { song, scores: { [playerId]: { displayName, color, avatar, pfp, score } } }
     * @type {object[]}
     */
    this.rateArchive = [];
    /** @type {Set<string>} players who pressed Continue on results */
    this.rateReadyNext = new Set();
    /**
     * Between songs: show who rated what + average (like bracket winnerBeat).
     * @type {null | {
     *   song: object,
     *   scores: object[],
     *   average: number,
     *   count: number,
     *   songNumber: number,
     *   total: number,
     *   isLast: boolean,
     *   nextSong: object|null
     * }}
     */
    this.rateReveal = null;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._rateRevealTimer = null;
    /** Lobby “I’m ready” chips (optional; cleared on start) */
    this.lobbyReadyIds = new Set();
    /** @type {Map<string, object>} */
    this.players = new Map();
    /** @type {Set<string>} session tokens banned from this room */
    this.bans = new Set();
    this.playlistMeta = null;
    this.playlistUrl = '';
    /**
     * Full lobby roster (all songs shown). Tournament uses only selected ids.
     * @type {object[]|null}
     */
    this._rawTracks = null;
    /** @type {Set<string>} */
    this._selectedIds = new Set();
    /** trackId → playerId who added (playlist bulk loads leave this unset) */
    this._trackAddedBy = new Map();
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
    // Chat is live-broadcast only — no server history (late joiners never get backlog).
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
      lobbyReadyIds:
        this.phase === PHASE.LOBBY ? [...this.lobbyReadyIds] : [],
      myLobbyReady: Boolean(
        this.phase === PHASE.LOBBY &&
          forPlayerId &&
          this.lobbyReadyIds.has(forPlayerId)
      ),
      playlist: this.playlistMeta
        ? {
            ...this.playlistMeta,
            trackCount: this._rawTracks?.length || this.playlistMeta.trackCount || 0,
            selectedCount: this._selectedIds?.size ?? this.playlistMeta.selectedCount,
          }
        : null,
      playlistUrl: this.playlistUrl || '',
      roster: this.publicRoster(),
      error: this.error || '',
      groupRate: this.publicGroupRate(forPlayerId),
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
            // Clients prefetch these previews during the celebration beat
            upcomingMatch: this.winnerBeat.upcomingMatch || null,
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

    // New players only in open lobby. Mid Group Rate: no new raters (design).
    // (Existing seats still rejoin above via session token — only if still connected slot free.)
    if (this.phase !== PHASE.LOBBY) {
      const err = new Error(
        this.phase === PHASE.CHAMPION || this.phase === PHASE.RATE_RESULTS
          ? 'Session finished — wait for everyone to continue to a new lobby.'
          : this.phase === PHASE.RATE_SONG || this.phase === PHASE.RATE_REVEAL
            ? 'Group Rate already started — no late join. Wait for the next lobby.'
            : 'Game already started — wait for the next lobby after this tournament.'
      );
      err.code = 'LOCKED';
      throw err;
    }

    const maxPlayers =
      this.settings.gameMode === GAME_MODE.GROUP_RATE
        ? MAX_PLAYERS_GROUP_RATE
        : MAX_PLAYERS;
    if (this.players.size >= maxPlayers) {
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
    this.lobbyReadyIds.delete(playerId);

    if (p.isHost) {
      this.transferHost();
    }

    // Group Rate: DC = out for the rest of this run (unlucky). Drop seat so no rejoin mid-game.
    // Keep a lock-in already submitted for the current song (name snapshotted at lock).
    if (
      this.phase === PHASE.RATE_SONG ||
      this.phase === PHASE.RATE_REVEAL ||
      this.phase === PHASE.RATE_RESULTS
    ) {
      this.rateRaterIds.delete(playerId);
      this.rateReadyNext.delete(playerId);
      this.players.delete(playerId);
      if (this.phase === PHASE.RATE_SONG) this.maybeAdvanceGroupRate();
      else if (this.phase === PHASE.RATE_RESULTS) this.maybeFinishResultsReady();
      // rate_reveal: keep celebrating; DC only drops seat
      this.broadcast();
      return;
    }

    // If mid-vote, re-check whether all remaining connected have voted
    if (this.phase === PHASE.MATCH && !this.paused) {
      this.maybeFinishVoting();
    }
    this.broadcast();
  }

  clampRateScore(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return null;
    return Math.min(10, Math.max(0, Math.round(x * 10) / 10));
  }

  clearGroupRateState() {
    this.clearRateRevealTimer();
    this.rateTracks = null;
    this.rateIndex = 0;
    this.rateRaterIds = new Set();
    this.rateSongScores = new Map();
    this.rateArchive = [];
    this.rateReadyNext = new Set();
    this.rateReveal = null;
  }

  clearRateRevealTimer() {
    if (this._rateRevealTimer) {
      clearTimeout(this._rateRevealTimer);
      this._rateRevealTimer = null;
    }
  }

  /** Toggle “I’m ready” in lobby (cosmetic coordination for host). */
  setLobbyReady(playerId, ready) {
    this.touch();
    if (this.phase !== PHASE.LOBBY || this.locked) return;
    const p = this.players.get(playerId);
    if (!p?.connected || p.banned) return;
    if (ready) this.lobbyReadyIds.add(playerId);
    else this.lobbyReadyIds.delete(playerId);
    this.broadcast();
  }

  /**
   * Host skips current Group Rate song → move to end of queue for later.
   * Clears lock-ins for that song (everyone will rate it again when it returns).
   */
  skipGroupRateSong(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.RATE_SONG || !this.rateTracks?.length) {
      const err = new Error('Nothing to skip.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    if (this.rateIndex >= this.rateTracks.length) return;
    const [song] = this.rateTracks.splice(this.rateIndex, 1);
    if (song) this.rateTracks.push(song);
    this.rateSongScores = new Map();
    // index stays pointing at what was “next”; after splice that’s the new current
    if (this.rateIndex >= this.rateTracks.length) {
      this.rateIndex = 0;
    }
    // If only one song left looping forever is fine; if empty shouldn't happen
    this.broadcast();
  }

  /** Host restarts Group Rate on the same locked track list (from last run / current roster). */
  rematchGroupRate(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.RATE_RESULTS && this.phase !== PHASE.LOBBY) {
      const err = new Error('Rematch is available after Group Rate results (or from lobby).');
      err.code = 'BAD_PHASE';
      throw err;
    }
    // Prefer songs from last run order; else selected roster
    let tracks = null;
    if (this.rateArchive?.length) {
      // Rebuild unique list from archive order + any remaining unrated from rateTracks
      const seen = new Set();
      tracks = [];
      for (const row of this.rateArchive) {
        const t = slimSong(row.song);
        if (t?.id && !seen.has(t.id)) {
          seen.add(t.id);
          tracks.push(t);
        }
      }
      if (this.rateTracks) {
        for (const t of this.rateTracks) {
          const s = slimSong(t);
          if (s?.id && !seen.has(s.id)) {
            seen.add(s.id);
            tracks.push(s);
          }
        }
      }
    }
    if (!tracks?.length) {
      tracks = this._rosterSelectedTracks();
    }
    if (!tracks?.length) {
      const err = new Error('No songs to rematch.');
      err.code = 'NO_PLAYLIST';
      throw err;
    }
    // Temporarily ensure mode + selected set for startGroupRate
    this.settings.gameMode = GAME_MODE.GROUP_RATE;
    this.phase = PHASE.LOBBY;
    this.locked = false;
    this.clearGroupRateState();
    this._rawTracks = tracks.map(slimSong).filter(Boolean);
    this._selectedIds = new Set(this._rawTracks.map((t) => t.id));
    this._syncPlaylistMetaCounts();
    this.startGroupRate(playerId);
  }

  /**
   * Host starts Group Rate: lock selected tracks, snapshot raters, first song.
   */
  startGroupRate(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (this.settings.gameMode !== GAME_MODE.GROUP_RATE) {
      const err = new Error('Switch the room to Group Rate mode first.');
      err.code = 'BAD_MODE';
      throw err;
    }
    if (this.phase !== PHASE.LOBBY || this.locked) {
      const err = new Error('Can only start Group Rate from the lobby.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    let selected = this._rosterSelectedTracks();
    if (selected.length < 1) {
      const err = new Error('Select at least 1 song to rate.');
      err.code = 'NO_PLAYLIST';
      throw err;
    }
    if (this.settings.seeding === 'shuffle') {
      // Fisher-Yates
      selected = [...selected];
      for (let i = selected.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [selected[i], selected[j]] = [selected[j], selected[i]];
      }
    }

    const raters = this.connectedVoters();
    if (raters.length < 1) {
      const err = new Error('Need at least one connected player.');
      err.code = 'NO_PLAYERS';
      throw err;
    }

    this.clearVoteTimer();
    this.tournament = null;
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.nowPlaying = null;
    this.error = '';
    this.locked = true;
    this.paused = false;
    this.lobbyReadyIds.clear();
    this.rateTracks = selected.map((t) => slimSong(t)).filter(Boolean);
    this.rateIndex = 0;
    this.rateRaterIds = new Set(raters.map((p) => p.id));
    this.rateSongScores = new Map();
    this.rateArchive = [];
    this.rateReadyNext = new Set();
    this.rateReveal = null;
    this.clearRateRevealTimer();
    this.phase = PHASE.RATE_SONG;
    this.broadcast();
  }

  /** Submit or change rating for the current song (0–10, 0.1 steps). */
  submitGroupRate(playerId, rawScore) {
    this.touch();
    if (this.phase !== PHASE.RATE_SONG) {
      const err = new Error('Not rating a song right now.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    if (!this.rateRaterIds.has(playerId)) {
      const err = new Error('You are not a rater in this session.');
      err.code = 'NOT_RATER';
      throw err;
    }
    const p = this.players.get(playerId);
    if (!p?.connected || p.banned) {
      const err = new Error('You cannot rate right now.');
      err.code = 'NO_RATE';
      throw err;
    }
    const score = this.clampRateScore(rawScore);
    if (score == null) {
      const err = new Error('Invalid rating.');
      err.code = 'BAD_SCORE';
      throw err;
    }
    this.rateSongScores.set(playerId, {
      score,
      displayName: p.displayName,
      color: p.color,
      avatar: p.avatar,
      pfp: p.pfp || null,
    });
    this.maybeAdvanceGroupRate();
    this.broadcast();
  }

  /** Required raters still in the room for the current song. */
  activeGroupRaters() {
    return [...this.rateRaterIds].filter((id) => {
      const p = this.players.get(id);
      return p && p.connected && !p.banned;
    });
  }

  rateScoreValue(entry) {
    if (entry == null) return null;
    if (typeof entry === 'number') return entry;
    return entry.score;
  }

  maybeAdvanceGroupRate() {
    if (this.phase !== PHASE.RATE_SONG || !this.rateTracks?.length) return;
    const need = this.activeGroupRaters();
    if (need.length < 1) {
      // Everyone left — finish current song if any scores, then results or lobby
      if (this.rateSongScores.size > 0 || this.rateArchive.length > 0) {
        if (this.rateIndex < this.rateTracks.length) {
          this.beginRateReveal();
          return;
        }
        this.phase = PHASE.RATE_RESULTS;
        this.rateReadyNext = new Set();
      } else {
        this.returnToLobbyAfterGroupRate();
      }
      return;
    }
    for (const id of need) {
      if (!this.rateSongScores.has(id)) return;
    }
    // All active raters locked in → celebration beat, then next song / results
    this.beginRateReveal();
  }

  /**
   * Archive current song, open rate_reveal phase (who rated what + average).
   * Auto-advances after ~4.5s (host can skip), same cadence as bracket winnerBeat.
   */
  beginRateReveal() {
    if (this.phase !== PHASE.RATE_SONG || !this.rateTracks?.length) return;
    const song = this.rateTracks[this.rateIndex];
    if (!song) {
      this.rateIndex = this.rateTracks.length;
      this.phase = PHASE.RATE_RESULTS;
      this.rateReadyNext = new Set();
      return;
    }

    const scoreList = [];
    const scoresMap = {};
    for (const [pid, entry] of this.rateSongScores) {
      const score = this.rateScoreValue(entry);
      if (score == null) continue;
      const p = this.players.get(pid);
      const snap = typeof entry === 'object' && entry ? entry : null;
      const row = {
        playerId: pid,
        displayName: p?.displayName || snap?.displayName || 'Player',
        color: p?.color || snap?.color || 'slate',
        avatar: p?.avatar || snap?.avatar || 'frog',
        pfp: p?.pfp || snap?.pfp || null,
        score,
      };
      scoreList.push(row);
      scoresMap[pid] = row;
    }

    // Highest first, then name for stable ties
    scoreList.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.displayName).localeCompare(String(b.displayName));
    });

    const vals = scoreList.map((s) => s.score);
    const avg =
      vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const average = Math.round(avg * 10) / 10;
    const songNumber = this.rateIndex + 1;
    const total = this.rateTracks.length;

    if (Object.keys(scoresMap).length > 0) {
      this.rateArchive.push({ song: slimSong(song), scores: scoresMap });
    }

    this.rateSongScores = new Map();
    this.rateIndex += 1;
    const isLast = this.rateIndex >= total;
    const nextSong = !isLast ? slimSong(this.rateTracks[this.rateIndex]) : null;

    this.rateReveal = {
      song: slimSong(song),
      scores: scoreList,
      average,
      count: vals.length,
      songNumber,
      total,
      isLast,
      nextSong,
    };
    this.phase = PHASE.RATE_REVEAL;
    this.nowPlaying = {
      side: 'rate_reveal',
      trackId: song.id,
      song: slimSong(song),
      playing: true,
    };

    this.clearRateRevealTimer();
    this._rateRevealTimer = setTimeout(() => {
      this._rateRevealTimer = null;
      if (this.phase !== PHASE.RATE_REVEAL) return;
      this.finishRateReveal();
    }, 4500);
  }

  finishRateReveal() {
    this.clearRateRevealTimer();
    if (this.phase !== PHASE.RATE_REVEAL) return;
    this.rateReveal = null;
    if (this.rateIndex >= (this.rateTracks?.length || 0)) {
      this.phase = PHASE.RATE_RESULTS;
      this.rateReadyNext = new Set();
      this.nowPlaying = null;
    } else {
      this.phase = PHASE.RATE_SONG;
      // Soft handoff: stop celebration nowPlaying so next song is local/manual
      this.nowPlaying = null;
    }
    this.broadcast();
  }

  /** Host skip on the between-song rating reveal (like skip_winner). */
  skipRateReveal(playerId) {
    this.assertHost(playerId);
    if (this.phase !== PHASE.RATE_REVEAL) return;
    this.finishRateReveal();
  }

  /** @deprecated path — kept if anything still calls finalize; prefer beginRateReveal */
  finalizeCurrentRateSong() {
    // Legacy: archive without reveal (should not be used mid-session now)
    const song = this.rateTracks?.[this.rateIndex];
    if (!song) {
      this.rateIndex = this.rateTracks?.length || 0;
      return;
    }
    const scores = {};
    for (const [pid, entry] of this.rateSongScores) {
      const score = this.rateScoreValue(entry);
      if (score == null) continue;
      const p = this.players.get(pid);
      const snap = typeof entry === 'object' && entry ? entry : null;
      scores[pid] = {
        playerId: pid,
        displayName: p?.displayName || snap?.displayName || 'Player',
        color: p?.color || snap?.color || 'slate',
        avatar: p?.avatar || snap?.avatar || 'frog',
        pfp: p?.pfp || snap?.pfp || null,
        score,
      };
    }
    if (Object.keys(scores).length > 0) {
      this.rateArchive.push({ song: slimSong(song), scores });
    }
    this.rateSongScores = new Map();
    this.rateIndex += 1;
  }

  buildGroupRateRanking() {
    const nameById = new Map();
    for (const p of this.players.values()) {
      nameById.set(p.id, {
        displayName: p.displayName,
        color: p.color,
        avatar: p.avatar,
        pfp: p.pfp || null,
      });
    }
    // Merge identities from archive (people who left after rating)
    for (const row of this.rateArchive) {
      for (const [pid, s] of Object.entries(row.scores || {})) {
        if (!nameById.has(pid)) {
          nameById.set(pid, {
            displayName: s.displayName,
            color: s.color,
            avatar: s.avatar,
            pfp: s.pfp || null,
          });
        }
      }
    }

    return this.rateArchive.map((row, order) => {
      const vals = Object.values(row.scores || {}).map((s) => s.score);
      const avg =
        vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      const rounded = Math.round(avg * 10) / 10;
      return {
        song: slimSong(row.song),
        average: rounded,
        count: vals.length,
        scores: Object.entries(row.scores || {}).map(([pid, s]) => ({
          playerId: pid,
          displayName: s.displayName,
          color: s.color,
          avatar: s.avatar,
          pfp: s.pfp || null,
          score: s.score,
        })),
        order,
      };
    }).sort((a, b) => {
      if (b.average !== a.average) return b.average - a.average;
      return a.order - b.order;
    });
  }

  /** Everyone presses Continue on results → open lobby (same room). */
  groupRateContinue(playerId) {
    this.touch();
    if (this.phase !== PHASE.RATE_RESULTS) {
      const err = new Error('Not on the results screen.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    const p = this.players.get(playerId);
    if (!p?.connected) {
      const err = new Error('Not connected.');
      err.code = 'NO';
      throw err;
    }
    this.rateReadyNext.add(playerId);
    this.maybeFinishResultsReady();
    this.broadcast();
  }

  maybeFinishResultsReady() {
    if (this.phase !== PHASE.RATE_RESULTS) return;
    const connected = [...this.players.values()].filter(
      (p) => p.connected && !p.banned
    );
    if (connected.length < 1) {
      this.returnToLobbyAfterGroupRate();
      return;
    }
    for (const p of connected) {
      if (!this.rateReadyNext.has(p.id)) return;
    }
    this.returnToLobbyAfterGroupRate();
  }

  returnToLobbyAfterGroupRate() {
    this.phase = PHASE.LOBBY;
    this.locked = false;
    this.paused = false;
    this.clearGroupRateState();
    this.tournament = null;
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.nowPlaying = null;
    this.error = '';
    this.clearVoteTimer();
    // Keep playlist/roster for another round
    this.broadcast();
  }

  publicGroupRate(forPlayerId) {
    if (
      this.phase !== PHASE.RATE_SONG &&
      this.phase !== PHASE.RATE_REVEAL &&
      this.phase !== PHASE.RATE_RESULTS
    ) {
      return null;
    }
    const me = forPlayerId ? this.players.get(forPlayerId) : null;
    const active = this.activeGroupRaters();
    const rated = active.filter((id) => this.rateSongScores.has(id)).length;
    const iAmRater = Boolean(forPlayerId && this.rateRaterIds.has(forPlayerId));
    const myEntry =
      forPlayerId && this.rateSongScores.has(forPlayerId)
        ? this.rateSongScores.get(forPlayerId)
        : null;
    const myRating = this.rateScoreValue(myEntry);

    if (this.phase === PHASE.RATE_SONG) {
      const song = this.rateTracks?.[this.rateIndex] || null;
      return {
        index: this.rateIndex,
        total: this.rateTracks?.length || 0,
        song: slimSong(song),
        ratedCount: rated,
        raterCount: active.length,
        // Privacy: only X/Y — no who, no scores
        myRating,
        iAmRater,
        canRate: iAmRater && Boolean(me?.connected),
        reveal: null,
      };
    }

    if (this.phase === PHASE.RATE_REVEAL) {
      const rev = this.rateReveal;
      return {
        index: Math.max(0, (rev?.songNumber || 1) - 1),
        total: rev?.total || this.rateTracks?.length || 0,
        song: rev?.song || null,
        ratedCount: rev?.count || 0,
        raterCount: rev?.count || 0,
        myRating: null,
        iAmRater,
        canRate: false,
        reveal: rev
          ? {
              song: rev.song,
              scores: rev.scores || [],
              average: rev.average,
              count: rev.count,
              songNumber: rev.songNumber,
              total: rev.total,
              isLast: Boolean(rev.isLast),
              nextSong: rev.nextSong || null,
            }
          : null,
      };
    }

    // Results
    const ranking = this.buildGroupRateRanking();
    const connected = [...this.players.values()].filter(
      (p) => p.connected && !p.banned
    );
    const ready = connected.filter((p) => this.rateReadyNext.has(p.id)).length;
    return {
      index: this.rateTracks?.length || 0,
      total: this.rateTracks?.length || 0,
      song: null,
      ratedCount: 0,
      raterCount: 0,
      myRating: null,
      iAmRater,
      canRate: false,
      reveal: null,
      ranking,
      playlistName: this.playlistMeta?.name || 'Group Rate',
      playlistOwner: this.playlistMeta?.owner || '',
      readyCount: ready,
      readyTotal: connected.length,
      myReady: Boolean(forPlayerId && this.rateReadyNext.has(forPlayerId)),
    };
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
    if (partial.gameMode === GAME_MODE.BRACKET || partial.gameMode === GAME_MODE.GROUP_RATE) {
      if (this.phase === PHASE.LOBBY && !this.locked) {
        this.settings.gameMode = partial.gameMode;
      }
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
    if (typeof partial.allowPartyAddSongs === 'boolean') {
      this.settings.allowPartyAddSongs = partial.allowPartyAddSongs;
    } else if (
      partial.allowPartyAddSongs === '1' ||
      partial.allowPartyAddSongs === 1 ||
      partial.allowPartyAddSongs === 'true'
    ) {
      this.settings.allowPartyAddSongs = true;
    } else if (
      partial.allowPartyAddSongs === '0' ||
      partial.allowPartyAddSongs === 0 ||
      partial.allowPartyAddSongs === 'false'
    ) {
      this.settings.allowPartyAddSongs = false;
    }
    this.broadcast();
  }

  _rosterSelectedTracks() {
    if (!this._rawTracks?.length) return [];
    return this._rawTracks.filter((t) => t?.id && this._selectedIds.has(t.id));
  }

  _syncPlaylistMetaCounts() {
    if (!this.playlistMeta) return;
    this.playlistMeta.trackCount = this._rawTracks?.length || 0;
    this.playlistMeta.selectedCount = this._selectedIds.size;
  }

  /**
   * Public roster snapshot for lobby UI (all players see songs; only host edits inclusion).
   */
  publicRoster() {
    if (this.phase !== PHASE.LOBBY || !this._rawTracks?.length) return null;
    const nameById = new Map();
    for (const p of this.players.values()) {
      nameById.set(p.id, p.displayName);
    }
    return {
      tracks: this._rawTracks.map((t, idx) => {
        const adderId = this._trackAddedBy.get(t.id) || null;
        return {
          ...slimSong(t),
          included: this._selectedIds.has(t.id),
          addedById: adderId,
          addedByName: adderId ? nameById.get(adderId) || 'Player' : null,
          index: idx + 1,
        };
      }),
      total: this._rawTracks.length,
      selected: this._selectedIds.size,
    };
  }

  /**
   * Host loaded playlist JSON from API (server-side fetch preferred via hub).
   * Loads into lobby roster (all included); host curates before Start.
   */
  setPlaylist(playerId, playlist, url) {
    this.assertHost(playerId);
    this.touch();
    this.error = '';

    if (!playlist?.tracks || playlist.tracks.length < 1) {
      this.error = 'No playable songs found.';
      this.playlistMeta = null;
      this.playlistUrl = '';
      this._rawTracks = null;
      this._selectedIds.clear();
      this._trackAddedBy.clear();
      this.broadcast();
      return;
    }

    // Dedupe preserving order (Spotify + YouTube allowed; mix OK)
    const seen = new Set();
    const tracks = [];
    for (const raw of playlist.tracks) {
      const t = slimSong(raw);
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push(t);
    }
    if (tracks.length < 1) {
      this.error = 'No playable songs found.';
      this.broadcast();
      return;
    }

    this.playlistUrl = String(url || '').slice(0, 500);
    this.playlistMeta = {
      id: playlist.id || 'custom',
      name: playlist.name || 'Playlist',
      image: playlist.image || tracks[0]?.image || null,
      owner: playlist.owner || '',
      trackCount: tracks.length,
      selectedCount: tracks.length,
      source: rosterSourceLabel(tracks) || playlist.source || 'mixed',
    };
    this._rawTracks = tracks;
    this._selectedIds = new Set(tracks.map((t) => t.id));
    this._trackAddedBy.clear();
    this.phase = PHASE.LOBBY;
    this.locked = false;
    this.tournament = null;
    this.votes.clear();
    this.clearVoteTimer();
    this.reveal = null;
    this.winnerBeat = null;
    this.broadcast();
  }

  /**
   * Append songs to the lobby roster.
   * - Single track: host always; others if allowPartyAddSongs
   * - Playlist / multi-track: **host only**
   * @param {string} playerId
   * @param {object[]} rawTracks
   * @param {{ fromPlaylist?: boolean, label?: string }} [opts]
   */
  appendTracks(playerId, rawTracks, opts = {}) {
    this.touch();
    const p = this.players.get(playerId);
    if (!p?.connected || p.banned) {
      const err = new Error('You cannot add songs.');
      err.code = 'NO_ADD';
      throw err;
    }
    if (this.phase !== PHASE.LOBBY || this.locked) {
      const err = new Error('Songs can only be added in the lobby.');
      err.code = 'BAD_PHASE';
      throw err;
    }

    const list = (Array.isArray(rawTracks) ? rawTracks : [])
      .map(slimSong)
      .filter(Boolean);
    if (!list.length) {
      const err = new Error('No songs to add.');
      err.code = 'BAD_SONG';
      throw err;
    }

    const fromPlaylist = Boolean(opts.fromPlaylist) || list.length > 1;
    if (fromPlaylist && !p.isHost) {
      const err = new Error(
        'Only the host can add entire playlists. You can still add a single song link.'
      );
      err.code = 'HOST_PLAYLIST_ONLY';
      throw err;
    }
    if (!p.isHost && !this.settings.allowPartyAddSongs) {
      const err = new Error('Only the host can add songs (party adding is off).');
      err.code = 'NOT_ALLOWED';
      throw err;
    }

    if (!this._rawTracks) {
      if (!p.isHost) {
        const err = new Error('Host needs to load a playlist first.');
        err.code = 'NO_PLAYLIST';
        throw err;
      }
      this._rawTracks = [];
      this._selectedIds = new Set();
      this._trackAddedBy.clear();
      this.playlistMeta = {
        id: 'custom',
        name: opts.label || 'Party mix',
        image: list[0]?.image || null,
        trackCount: 0,
        selectedCount: 0,
        source: 'mixed',
      };
      this.playlistUrl = this.playlistUrl || '';
    }

    let added = 0;
    let reselected = 0;
    for (const song of list) {
      if (this._rawTracks.length >= 500) break;
      const existing = this._rawTracks.find((t) => t.id === song.id);
      if (existing) {
        if (!this._selectedIds.has(song.id)) {
          this._selectedIds.add(song.id);
          reselected += 1;
        }
        continue;
      }
      this._rawTracks.push(song);
      this._selectedIds.add(song.id);
      this._trackAddedBy.set(song.id, playerId);
      added += 1;
    }

    if (!this.playlistMeta?.image && list[0]?.image) {
      this.playlistMeta.image = list[0].image;
    }
    // If host pasted another playlist name and we still have a generic title, soft-update
    if (
      p.isHost &&
      opts.label &&
      this.playlistMeta &&
      (!this.playlistMeta.name ||
        this.playlistMeta.name === 'Party mix' ||
        this.playlistMeta.name === 'Playlist')
    ) {
      this.playlistMeta.name = opts.label;
    }
    if (this.playlistMeta) {
      this.playlistMeta.source = rosterSourceLabel(this._rawTracks);
    }

    this.error = '';
    this._syncPlaylistMetaCounts();
    this.broadcast();
    return { added, reselected, total: this._rawTracks.length };
  }

  /**
   * Add one track (guest-safe when allowPartyAddSongs). Prefer appendTracks for playlists.
   */
  addSong(playerId, track) {
    return this.appendTracks(playerId, [track], { fromPlaylist: false });
  }

  /** Host only: include/exclude a song from the upcoming bracket. */
  setSongIncluded(playerId, trackId, included) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.LOBBY || this.locked) {
      const err = new Error('Can only edit the roster in the lobby.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    const id = String(trackId || '');
    if (!this._rawTracks?.some((t) => t.id === id)) {
      const err = new Error('Song not in roster.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (included) this._selectedIds.add(id);
    else this._selectedIds.delete(id);
    this._syncPlaylistMetaCounts();
    this.broadcast();
  }

  /** Host only: select all / none / invert. */
  bulkSetIncluded(playerId, mode) {
    this.assertHost(playerId);
    this.touch();
    if (this.phase !== PHASE.LOBBY || this.locked || !this._rawTracks?.length) {
      const err = new Error('Can only edit the roster in the lobby.');
      err.code = 'BAD_PHASE';
      throw err;
    }
    if (mode === 'all') {
      this._selectedIds = new Set(this._rawTracks.map((t) => t.id));
    } else if (mode === 'none') {
      this._selectedIds.clear();
    } else if (mode === 'invert') {
      const next = new Set();
      for (const t of this._rawTracks) {
        if (!this._selectedIds.has(t.id)) next.add(t.id);
      }
      this._selectedIds = next;
    } else {
      const err = new Error('Unknown bulk mode.');
      err.code = 'BAD_MODE';
      throw err;
    }
    this._syncPlaylistMetaCounts();
    this.broadcast();
  }

  startTournament(playerId) {
    this.assertHost(playerId);
    this.touch();
    if (this.settings.gameMode === GAME_MODE.GROUP_RATE) {
      return this.startGroupRate(playerId);
    }
    const selected = this._rosterSelectedTracks();
    if (selected.length < 2) {
      const err = new Error(
        this._rawTracks?.length
          ? 'Select at least 2 songs for the tournament.'
          : 'Load a Spotify playlist (or add songs) first.'
      );
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
        source: rosterSourceLabel(selected) || this.playlistMeta?.source || 'mixed',
      },
      selected,
      this.settings.seeding
    );
    this.locked = true;
    this.paused = false;
    this.lobbyReadyIds.clear();
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.error = '';
    this.clearGroupRateState();
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
    // Peek next match without advancing — clients load previews during celebration
    let upcomingMatch = null;
    try {
      const peek = peekNextMatch(this.tournament, winnerSide);
      if (peek?.a?.id && peek?.b?.id) {
        upcomingMatch = {
          a: slimSong(peek.a),
          b: slimSong(peek.b),
          region: peek.region || null,
        };
      }
    } catch {
      upcomingMatch = null;
    }

    // Celebration: winner (large) + loser (small/grey) + voter chips with custom PFPs
    this.winnerBeat = {
      song: winnerSong,
      loserSong,
      voters,
      losers,
      winnerSide,
      abstentions: this.abstentions || [],
      upcomingMatch,
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
    if (this.phase !== PHASE.CHAMPION && this.phase !== PHASE.RATE_RESULTS) {
      const err = new Error('Only available after a tournament or Group Rate ends.');
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
    this.clearGroupRateState();
    // Keep last roster + meta so host can re-curate or load a new link
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
    // Drop heavy refs so GC can free playlist + tournament graphs
    this.tournament = null;
    this._rawTracks = null;
    this._selectedIds.clear();
    this._trackAddedBy.clear();
    this.playlistMeta = null;
    this.votes.clear();
    this.reveal = null;
    this.winnerBeat = null;
    this.nowPlaying = null;
    this.abstentions = [];
    this.clearGroupRateState();
    for (const p of this.players.values()) {
      try {
        p.ws = null;
      } catch {
      }
    }
  }
}
