/**
 * Public YouTube playlist loading via Data API v3.
 * Requires YOUTUBE_API_KEY in the environment (Google Cloud → YouTube Data API v3).
 */

const PAGE_SIZE = 50;
const MAX_ITEMS = 300;
const API_BASE = 'https://www.googleapis.com/youtube/v3';

function getApiKey() {
  const key = (process.env.YOUTUBE_API_KEY || process.env.YT_API_KEY || '').trim();
  return key || null;
}

function extractYouTubePlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // Bare playlist id (PL… / UU… / LL… / OL… / RD… etc.)
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed) && /^(PL|UU|LL|FL|OL|RD|PR)/.test(trimmed)) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'youtu.be'
    ) {
      const list = url.searchParams.get('list');
      if (list) return list;
    }
  } catch {
  }

  const loose = trimmed.match(/[?&]list=([A-Za-z0-9_-]+)/);
  return loose?.[1] || null;
}

function isYouTubePlaylistUrl(input) {
  return Boolean(extractYouTubePlaylistId(input));
}

/**
 * Extract a single video id from watch / youtu.be / shorts / embed / music links.
 * Prefer v= over list= so "video in playlist" links still resolve as a song.
 */
function extractYouTubeVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // Bare 11-char video id (common YouTube form)
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) return trimmed;

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (
      host === 'youtu.be' ||
      host === 'youtube.com' ||
      host === 'm.youtube.com' ||
      host === 'music.youtube.com' ||
      host === 'www.youtube.com'
    ) {
      if (host === 'youtu.be') {
        const id = url.pathname.split('/').filter(Boolean)[0];
        if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
      }
      const v = url.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;

      const parts = url.pathname.split('/').filter(Boolean);
      // /embed/ID, /shorts/ID, /live/ID, /v/ID
      const kindIdx = parts.findIndex((p) =>
        ['embed', 'shorts', 'live', 'v'].includes(p)
      );
      if (kindIdx !== -1 && parts[kindIdx + 1]) {
        const id = parts[kindIdx + 1].split('?')[0];
        if (/^[A-Za-z0-9_-]{11}$/.test(id)) return id;
      }
    }
  } catch {
  }

  const loose = trimmed.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/
  );
  return loose?.[1] || null;
}

function isYouTubeVideoUrl(input) {
  return Boolean(extractYouTubeVideoId(input));
}

function trackFromVideoResource(item) {
  const sn = item?.snippet;
  const vid = item?.id;
  if (!vid || typeof vid !== 'string') return null;

  const title = (sn?.title || '').trim();
  if (!title || /^private video$/i.test(title) || /^deleted video$/i.test(title)) {
    return null;
  }

  const thumbs = sn?.thumbnails || {};
  const image =
    thumbs.medium?.url ||
    thumbs.high?.url ||
    thumbs.default?.url ||
    `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

  const channel = (sn?.channelTitle || '').trim();

  return {
    id: vid,
    name: title,
    artists: channel || 'YouTube',
    image,
    youtubeId: vid,
    source: 'youtube',
    spotifyUrl: null,
    youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
    embedUrl: `https://www.youtube.com/embed/${vid}?enablejsapi=1&rel=0&modestbranding=1`,
  };
}

/** Single public video metadata (solo “add song” by YouTube link). */
async function fetchYouTubeVideo(videoId) {
  const id = String(videoId || '').trim();
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) {
    const err = new Error('Invalid YouTube video id.');
    err.status = 400;
    throw err;
  }

  const body = await ytGet('videos', {
    part: 'snippet,status',
    id,
    maxResults: '1',
  });
  const item = body?.items?.[0];
  if (!item) {
    const err = new Error(
      'YouTube video not found. Check the link and that the video is public.'
    );
    err.status = 404;
    throw err;
  }

  const privacy = item?.status?.privacyStatus;
  if (privacy === 'private') {
    const err = new Error('That YouTube video is private.');
    err.status = 403;
    throw err;
  }

  const track = trackFromVideoResource(item);
  if (!track) {
    const err = new Error('Could not read that YouTube video.');
    err.status = 404;
    throw err;
  }
  return track;
}

async function ytGet(path, params) {
  const key = getApiKey();
  if (!key) {
    const err = new Error(
      'YouTube playlists need a YOUTUBE_API_KEY. Add one from Google Cloud (YouTube Data API v3) to your .env / Render env vars.'
    );
    err.status = 503;
    err.code = 'YOUTUBE_API_KEY_MISSING';
    throw err;
  }

  const qs = new URLSearchParams({ ...params, key });
  const res = await fetch(`${API_BASE}/${path}?${qs}`, {
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const msg =
      body?.error?.message ||
      (res.status === 403
        ? 'YouTube API rejected the request (check API key / quota).'
        : `YouTube API error (${res.status}).`);
    const err = new Error(msg);
    err.status = res.status === 403 ? 403 : 502;
    err.code = 'YOUTUBE_API';
    throw err;
  }

  return body;
}

function trackFromPlaylistItem(item) {
  const sn = item?.snippet;
  const vid =
    sn?.resourceId?.videoId ||
    item?.contentDetails?.videoId ||
    null;
  if (!vid || typeof vid !== 'string') return null;

  // Skip wiped / private placeholders when title is known-missing
  const title = (sn?.title || '').trim();
  if (!title || /^private video$/i.test(title) || /^deleted video$/i.test(title)) {
    return null;
  }

  const thumbs = sn?.thumbnails || {};
  const image =
    thumbs.medium?.url ||
    thumbs.high?.url ||
    thumbs.default?.url ||
    `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

  const channel = (sn?.videoOwnerChannelTitle || sn?.channelTitle || '').trim();

  return {
    id: vid,
    name: title,
    artists: channel || 'YouTube',
    image,
    youtubeId: vid,
    source: 'youtube',
    spotifyUrl: null,
    youtubeUrl: `https://www.youtube.com/watch?v=${vid}`,
    embedUrl: `https://www.youtube.com/embed/${vid}?enablejsapi=1&rel=0&modestbranding=1`,
  };
}

async function fetchYouTubePlaylist(playlistId) {
  const id = String(playlistId || '').trim();
  if (!id) {
    const err = new Error('Invalid YouTube playlist id.');
    err.status = 400;
    throw err;
  }

  // Meta
  const metaBody = await ytGet('playlists', {
    part: 'snippet,contentDetails',
    id,
    maxResults: '1',
  });
  const meta = metaBody?.items?.[0];
  if (!meta) {
    const err = new Error(
      'YouTube playlist not found. Check the link and that the playlist is public.'
    );
    err.status = 404;
    throw err;
  }

  const sn = meta.snippet || {};
  const thumbs = sn.thumbnails || {};
  const image =
    thumbs.medium?.url ||
    thumbs.high?.url ||
    thumbs.default?.url ||
    null;

  const tracks = [];
  const seen = new Set();
  let pageToken = '';

  while (tracks.length < MAX_ITEMS) {
    const params = {
      part: 'snippet,contentDetails,status',
      playlistId: id,
      maxResults: String(PAGE_SIZE),
    };
    if (pageToken) params.pageToken = pageToken;

    const page = await ytGet('playlistItems', params);
    const items = page?.items || [];
    if (!items.length) break;

    for (const item of items) {
      // Skip unplayable when status says so
      const privacy = item?.status?.privacyStatus;
      if (privacy === 'private') continue;

      const t = trackFromPlaylistItem(item);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push(t);
      if (tracks.length >= MAX_ITEMS) break;
    }

    pageToken = page.nextPageToken || '';
    if (!pageToken) break;
  }

  // Allow 1+ so solo can load a short list and add more videos by link
  if (tracks.length < 1) {
    const err = new Error(
      'No playable videos found in that YouTube playlist.'
    );
    err.status = 400;
    throw err;
  }

  return {
    id,
    name: sn.title || 'YouTube playlist',
    description: sn.description || '',
    image,
    owner: sn.channelTitle || '',
    spotifyUrl: null,
    youtubeUrl: `https://www.youtube.com/playlist?list=${id}`,
    source: 'youtube',
    totalFromYouTube: meta.contentDetails?.itemCount ?? tracks.length,
    tracks,
  };
}

export {
  getApiKey,
  extractYouTubePlaylistId,
  extractYouTubeVideoId,
  isYouTubePlaylistUrl,
  isYouTubeVideoUrl,
  fetchYouTubePlaylist,
  fetchYouTubeVideo,
};
