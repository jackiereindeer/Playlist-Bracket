/**
 * Party WebSocket hub: create/join rooms, route messages, broadcast snapshots.
 */
import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import { Room } from './room.js';
import { CODE_ALPHABET, CODE_LENGTH, COLORS, AVATARS } from './constants.js';
import { resolveMediaUrl } from '../resolve-media.js';

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
      // Cap payload size (custom PFPs are already ~120KB max on the room side)
      const rawStr = typeof raw === 'string' ? raw : String(raw);
      if (rawStr.length > 250_000) {
        return send(ws, 'error', { error: 'Message too large.' });
      }
      let msg;
      try {
        msg = JSON.parse(rawStr);
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
    send(ws, 'joined', { state: room.snapshot(player.id) });
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
      // Host replaces the roster with this link (playlist or single song)
      room.assertHost(pid);
      const url = String(msg.url || '').slice(0, 500);
      send(ws, 'loading', { what: 'playlist' });
      const resolved = await resolveMediaUrl(url);
      room.setPlaylist(
        pid,
        {
          id: resolved.id || resolved.tracks[0]?.id || 'custom',
          name: resolved.name || 'Playlist',
          image: resolved.image || resolved.tracks[0]?.image || null,
          source: resolved.source,
          tracks: resolved.tracks,
        },
        url
      );
      break;
    }
    case 'add_song':
    case 'add_media': {
      // Single song: host or allowPartyAdd. Entire playlist: host only.
      const url = String(msg.url || '').slice(0, 500);
      send(ws, 'loading', { what: 'import' });
      const resolved = await resolveMediaUrl(url);
      const fromPlaylist = resolved.kind === 'playlist' || resolved.tracks.length > 1;
      room.appendTracks(pid, resolved.tracks, {
        fromPlaylist,
        label: resolved.name,
      });
      break;
    }
    case 'roster_include':
      room.setSongIncluded(pid, msg.trackId ?? msg.id, Boolean(msg.included ?? msg.on));
      break;
    case 'roster_bulk':
      room.bulkSetIncluded(pid, msg.mode || msg.bulk);
      break;
    case 'start':
      room.startTournament(pid);
      break;
    case 'group_rate_submit':
    case 'rate_submit':
      room.submitGroupRate(pid, msg.score ?? msg.rating ?? msg.value);
      break;
    case 'group_rate_continue':
    case 'rate_continue':
      room.groupRateContinue(pid);
      break;
    case 'lobby_ready':
      room.setLobbyReady(pid, msg.ready !== false && msg.ready !== 0);
      break;
    case 'group_rate_skip':
    case 'rate_skip':
      room.skipGroupRateSong(pid);
      break;
    case 'group_rate_rematch':
    case 'rate_rematch':
      room.rematchGroupRate(pid);
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
    case 'skip_rate_reveal':
      room.skipRateReveal(pid);
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
