/**
 * Party WebSocket hub: create/join rooms, route messages, broadcast snapshots.
 */
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { Room } from './room.js';
import { CODE_ALPHABET, CODE_LENGTH, COLORS, AVATARS } from './constants.js';
import {
  extractPlaylistId,
  fetchPublicPlaylist,
} from '../spotify-public.js';
import { isYouTubePlaylistUrl } from '../youtube-public.js';

function genCode() {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return s;
}

function send(ws, type, payload = {}) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify({ type, ...payload }));
  } catch {
  }
}

export function attachPartyHub(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/party' });
  /** @type {Map<string, Room>} */
  const rooms = new Map();

  const hub = {
    broadcast(room) {
      for (const p of room.players.values()) {
        if (p.ws && p.connected) {
          send(p.ws, 'state', { state: room.snapshot(p.id) });
        }
      }
    },
    /** Send a non-state event to everyone currently connected in the room. */
    sendToRoom(room, type, payload = {}) {
      for (const p of room.players.values()) {
        if (p.ws && p.connected) {
          send(p.ws, type, payload);
        }
      }
    },
  };

  // Idle room reaper
  setInterval(() => {
    for (const [code, room] of rooms) {
      if (room.isIdle() || room.players.size === 0) {
        room.destroy();
        rooms.delete(code);
      }
    }
  }, 60_000).unref?.();

  wss.on('connection', (ws) => {
    /** @type {{ room: Room|null, playerId: string|null }} */
    const ctx = { room: null, playerId: null };

    send(ws, 'hello', {
      colors: COLORS,
      avatars: AVATARS,
      message: 'Playlist Bracket party — local/multiplayer hub',
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return send(ws, 'error', { error: 'Bad message.' });
      }
      const type = msg?.type;
      try {
        await handle(ws, ctx, msg, type, rooms, hub);
      } catch (err) {
        send(ws, 'error', {
          error: err.message || 'Something went wrong.',
          code: err.code || undefined,
        });
      }
    });

    ws.on('close', () => {
      if (ctx.room && ctx.playerId) {
        ctx.room.setDisconnected(ctx.playerId);
        if (ctx.room.players.size === 0) {
          ctx.room.destroy();
          rooms.delete(ctx.room.code);
        }
      }
    });
  });

  console.log('[party] WebSocket hub on path /party');
  return { wss, rooms };
}

async function handle(ws, ctx, msg, type, rooms, hub) {
  if (type === 'create') {
    let code = genCode();
    while (rooms.has(code)) code = genCode();
    const room = new Room(code, hub);
    rooms.set(code, room);
    const player = room.addPlayer({
      displayName: msg.displayName,
      color: msg.color,
      avatar: msg.avatar,
      pfp: msg.pfp,
      sessionToken: msg.sessionToken,
      preferHost: true,
    });
    player.ws = ws;
    ctx.room = room;
    ctx.playerId = player.id;
    send(ws, 'joined', {
      state: room.snapshot(player.id),
    });
    return;
  }

  if (type === 'join') {
    const code = String(msg.code || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, CODE_LENGTH);
    const room = rooms.get(code);
    if (!room) {
      const err = new Error('Room not found. Check the code.');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const player = room.addPlayer({
      displayName: msg.displayName,
      color: msg.color,
      avatar: msg.avatar,
      pfp: msg.pfp,
      sessionToken: msg.sessionToken,
    });
    player.ws = ws;
    ctx.room = room;
    ctx.playerId = player.id;
    room.broadcast();
    send(ws, 'joined', { state: room.snapshot(player.id) });
    return;
  }

  if (!ctx.room || !ctx.playerId) {
    const err = new Error('Join or create a room first.');
    err.code = 'NO_ROOM';
    throw err;
  }

  const room = ctx.room;
  const pid = ctx.playerId;

  switch (type) {
    case 'settings':
      room.updateSettings(pid, msg.settings || msg);
      break;
    case 'load_playlist': {
      room.assertHost(pid);
      const url = String(msg.url || '').slice(0, 500);
      if (isYouTubePlaylistUrl(url)) {
        const err = new Error(
          'Party mode is Spotify-only for now. Use a public Spotify playlist.'
        );
        err.code = 'SPOTIFY_ONLY';
        throw err;
      }
      const id = extractPlaylistId(url);
      if (!id) {
        const err = new Error('Invalid Spotify playlist link.');
        err.code = 'BAD_URL';
        throw err;
      }
      send(ws, 'loading', { what: 'playlist' });
      const playlist = await fetchPublicPlaylist(id);
      room.setPlaylist(pid, playlist, url);
      break;
    }
    case 'start':
      room.startTournament(pid);
      break;
    case 'vote':
      room.castVote(pid, msg.side, { random: false });
      break;
    case 'vote_random':
      room.castVote(pid, 'a', { random: true });
      break;
    case 'skip_timer':
      // Disabled by design
      break;
    case 'skip_winner':
      room.skipWinner(pid);
      break;
    case 'new_lobby':
      room.newLobby(pid);
      break;
    case 'host_play':
      room.hostPlay(pid, msg.side);
      break;
    case 'host_pause':
      room.hostPause(pid);
      break;
    case 'report_no_preview':
      room.reportNoPreview(pid, msg.side);
      break;
    case 'tie_break':
      room.hostBreakTie(pid, msg.side);
      break;
    case 'pause':
      room.setPaused(pid, true);
      break;
    case 'unpause':
      room.setPaused(pid, false);
      break;
    case 'kick':
      room.kick(pid, msg.targetId);
      break;
    case 'ban':
      room.ban(pid, msg.targetId);
      break;
    case 'chat':
    case 'chat_send':
      room.postChat(pid, msg.text ?? msg.message ?? '');
      break;
    case 'export': {
      const data = room.exportRecovery(pid);
      send(ws, 'export', { data });
      break;
    }
    case 'end_room': {
      room.assertHost(pid);
      const code = room.code;
      // Tell everyone *before* closing sockets (closing first ate the host's "ended" message)
      const sockets = [];
      for (const p of room.players.values()) {
        if (p.ws) sockets.push(p.ws);
      }
      for (const sock of sockets) {
        send(sock, 'ended', { reason: 'host_ended' });
      }
      room.endRoom();
      room.destroy();
      rooms.delete(code);
      ctx.room = null;
      ctx.playerId = null;
      break;
    }
    case 'ping':
      send(ws, 'pong', { t: Date.now() });
      break;
    default:
      send(ws, 'error', { error: `Unknown type: ${type}` });
  }
}
