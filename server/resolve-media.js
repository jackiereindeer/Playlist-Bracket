/**
 * Resolve a pasted URL into one or more songs (Spotify/YouTube track or playlist).
 * Used by HTTP /api/import and the party hub.
 */
import {
  extractPlaylistId,
  extractTrackId,
  fetchPublicPlaylist,
  fetchPublicTrack,
} from './spotify-public.js';
import {
  extractYouTubePlaylistId,
  extractYouTubeVideoId,
  isYouTubePlaylistUrl,
  fetchYouTubePlaylist,
  fetchYouTubeVideo,
} from './youtube-public.js';

function normalizeTrack(t) {
  if (!t?.id) return null;
  const source = t.source || (t.youtubeId || t.youtubeUrl ? 'youtube' : 'spotify');
  return {
    id: t.id,
    name: t.name || 'Unknown',
    artists: t.artists || '',
    image: t.image || null,
    source,
    spotifyUrl: t.spotifyUrl || null,
    youtubeUrl: t.youtubeUrl || null,
    youtubeId: t.youtubeId || (source === 'youtube' ? t.id : null),
    embedUrl: t.embedUrl || null,
  };
}

/**
 * @param {string} rawUrl
 * @returns {Promise<{
 *   kind: 'track'|'playlist',
 *   name: string,
 *   source: string,
 *   tracks: object[],
 * }>}
 */
export async function resolveMediaUrl(rawUrl) {
  const raw = String(rawUrl || '').trim().slice(0, 500);
  if (!raw) {
    const err = new Error('Paste a Spotify or YouTube link.');
    err.status = 400;
    err.code = 'BAD_URL';
    throw err;
  }

  // --- YouTube video (prefer over playlist when v= / youtu.be / shorts) ---
  const ytVideoId = extractYouTubeVideoId(raw);
  const hasYtVideoPath =
    Boolean(ytVideoId) &&
    /([?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)/i.test(raw);
  if (hasYtVideoPath) {
    const track = normalizeTrack(await fetchYouTubeVideo(ytVideoId));
    return {
      kind: 'track',
      name: track.name,
      source: 'youtube',
      tracks: [track],
    };
  }

  // --- YouTube playlist ---
  if (isYouTubePlaylistUrl(raw)) {
    const plId = extractYouTubePlaylistId(raw);
    if (!plId) {
      const err = new Error('Invalid YouTube playlist link.');
      err.status = 400;
      err.code = 'BAD_URL';
      throw err;
    }
    const playlist = await fetchYouTubePlaylist(plId);
    const tracks = (playlist.tracks || []).map(normalizeTrack).filter(Boolean);
    if (!tracks.length) {
      const err = new Error('No playable videos in that YouTube playlist.');
      err.status = 400;
      throw err;
    }
    return {
      kind: 'playlist',
      name: playlist.name || 'YouTube playlist',
      source: 'youtube',
      tracks,
      image: playlist.image || null,
      id: playlist.id,
    };
  }

  // Bare 11-char → YouTube video (Spotify track ids are 22 chars)
  if (/^[A-Za-z0-9_-]{11}$/.test(raw) && ytVideoId) {
    const track = normalizeTrack(await fetchYouTubeVideo(ytVideoId));
    return {
      kind: 'track',
      name: track.name,
      source: 'youtube',
      tracks: [track],
    };
  }

  // --- Spotify track ---
  const looksLikeSpotifyTrack =
    /open\.spotify\.com\/track\//i.test(raw) || /^spotify:track:/i.test(raw);
  if (looksLikeSpotifyTrack) {
    const trackId = extractTrackId(raw);
    if (!trackId) {
      const err = new Error('Invalid Spotify song link.');
      err.status = 400;
      err.code = 'BAD_URL';
      throw err;
    }
    const track = normalizeTrack({
      ...(await fetchPublicTrack(trackId)),
      source: 'spotify',
    });
    return {
      kind: 'track',
      name: track.name,
      source: 'spotify',
      tracks: [track],
    };
  }

  // --- Spotify playlist ---
  const playlistId = extractPlaylistId(raw);
  if (playlistId) {
    const playlist = await fetchPublicPlaylist(playlistId);
    const tracks = (playlist.tracks || [])
      .map((t) => normalizeTrack({ ...t, source: t.source || 'spotify' }))
      .filter(Boolean);
    if (!tracks.length) {
      const err = new Error('No playable songs in that Spotify playlist.');
      err.status = 400;
      throw err;
    }
    return {
      kind: 'playlist',
      name: playlist.name || 'Playlist',
      source: 'spotify',
      tracks,
      image: playlist.image || null,
      id: playlist.id,
    };
  }

  // Last chance: Spotify track id / generic track extract
  const trackId = extractTrackId(raw);
  if (trackId) {
    const track = normalizeTrack({
      ...(await fetchPublicTrack(trackId)),
      source: 'spotify',
    });
    return {
      kind: 'track',
      name: track.name,
      source: 'spotify',
      tracks: [track],
    };
  }

  const err = new Error(
    'Unrecognized link. Paste a Spotify or YouTube song or playlist URL.'
  );
  err.status = 400;
  err.code = 'BAD_URL';
  throw err;
}
