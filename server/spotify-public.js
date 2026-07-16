const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const PATHFINDER_URL = 'https://api-partner.spotify.com/pathfinder/v1/query';

const FETCH_PLAYLIST_HASH =
  'a65e12194ed5fc443a1cdebed5fabe33ca5b07b987185d63c72483867ad13cb4';

const BOOTSTRAP_TRACK_ID = '4uLU6hMCjMI75M1A2tKUQC';
const PAGE_SIZE = 100;
const TOKEN_SKEW_MS = 60_000;

let tokenCache = { accessToken: null, expiresAtMs: 0 };
let cookieJar = '';
let cookieJarAt = 0;

function extractPlaylistId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  const uriMatch = trimmed.match(/^spotify:playlist:([a-zA-Z0-9]+)$/);
  if (uriMatch) return uriMatch[1];

  try {
    const url = new URL(trimmed);
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'open.spotify.com' || host === 'spotify.link' || host === 'embed.spotify.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      const playlistIdx = parts.indexOf('playlist');
      if (playlistIdx !== -1 && parts[playlistIdx + 1]) {
        return parts[playlistIdx + 1].split('?')[0];
      }
    }
  } catch {

  }

  if (/^[a-zA-Z0-9]{22}$/.test(trimmed)) return trimmed;
  return null;
}

function parseNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf('</script>', jsonStart);
  if (jsonEnd === -1) return null;
  try {
    return JSON.parse(html.slice(jsonStart, jsonEnd));
  } catch {
    return null;
  }
}

function mergeCookies(existing, setCookieHeaders) {
  const map = new Map();
  if (existing) {
    for (const part of existing.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k) map.set(k, rest.join('='));
    }
  }
  for (const raw of setCookieHeaders || []) {
    const pair = String(raw).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) map.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function refreshCookieJar() {
  if (cookieJar && Date.now() - cookieJarAt < 10 * 60 * 1000) return cookieJar;
  try {
    const res = await fetch('https://open.spotify.com/', {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const setCookies = res.headers.getSetCookie?.() || [];
    cookieJar = mergeCookies(cookieJar, setCookies);
    cookieJarAt = Date.now();
  } catch {
  }
  return cookieJar;
}

function browserHeaders(extra = {}) {
  const headers = {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
    ...extra,
  };
  if (cookieJar) headers.Cookie = cookieJar;
  return headers;
}

async function fetchEmbedHtml(kind, id) {
  await refreshCookieJar();
  const res = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, {
    headers: browserHeaders({
      Referer: 'https://open.spotify.com/',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Dest': 'iframe',
      'Sec-Fetch-Mode': 'navigate',
    }),
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  const setCookies = res.headers.getSetCookie?.() || [];
  if (setCookies.length) {
    cookieJar = mergeCookies(cookieJar, setCookies);
    cookieJarAt = Date.now();
  }
  if (!res.ok) {
    const err = new Error(
      res.status === 404
        ? 'Not found on Spotify.'
        : `Could not reach Spotify embed (${res.status}).`
    );
    err.status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return res.text();
}

function extractPreviewUrlFromHtml(html, nextData) {
  const entity = nextData?.props?.pageProps?.state?.data?.entity;
  if (entity?.audioPreview?.url) return entity.audioPreview.url;

  const fromJson = html.match(
    /"audioPreview"\s*:\s*\{[^}]*"url"\s*:\s*"(https:\/\/p\.scdn\.co\/mp3-preview\/[^"]+)"/
  );
  if (fromJson?.[1]) return fromJson[1].replace(/\\u002F/g, '/');

  const loose = html.match(/https:\/\/p\.scdn\.co\/mp3-preview\/[a-f0-9]+/i);
  return loose?.[0] || null;
}

async function getAnonymousToken() {
  const now = Date.now();
  if (tokenCache.accessToken && tokenCache.expiresAtMs > now + TOKEN_SKEW_MS) {
    return tokenCache.accessToken;
  }

  const html = await fetchEmbedHtml('track', BOOTSTRAP_TRACK_ID);
  const next = parseNextData(html);
  const session = next?.props?.pageProps?.state?.settings?.session;
  const token = session?.accessToken;
  const expires = session?.accessTokenExpirationTimestampMs;

  if (!token || typeof expires !== 'number') {
    const err = new Error(
      'Could not get a public session from Spotify. Try again in a moment.'
    );
    err.status = 502;
    throw err;
  }

  tokenCache = { accessToken: token, expiresAtMs: expires };
  return token;
}

function invalidateToken() {
  tokenCache = { accessToken: null, expiresAtMs: 0 };
}

function buildPlaylistQueryUrl(playlistId, offset, limit) {
  const variables = {
    uri: `spotify:playlist:${playlistId}`,
    offset,
    limit,
    enableWatchFeedEntrypoint: false,
  };
  const params = new URLSearchParams({
    operationName: 'fetchPlaylist',
    variables: JSON.stringify(variables),
    extensions: JSON.stringify({
      persistedQuery: { version: 1, sha256Hash: FETCH_PLAYLIST_HASH },
    }),
  });
  return `${PATHFINDER_URL}?${params}`;
}

function trackFromPathfinderRow(row) {
  const data = row?.itemV2?.data || row?.itemV3?.data;
  if (!data || data.__typename !== 'Track') return null;
  const id = typeof data.uri === 'string' ? data.uri.split(':').pop() : null;
  if (!id) return null;

  const artists =
    data.artists?.items
      ?.map((a) => a?.profile?.name)
      .filter(Boolean)
      .join(', ') ||
    data.albumOfTrack?.artists?.items
      ?.map((a) => a?.profile?.name)
      .filter(Boolean)
      .join(', ') ||
    'Unknown artist';

  const sources = data.albumOfTrack?.coverArt?.sources || [];
  const image =
    sources.find((s) => s?.width >= 300)?.url ||
    sources[0]?.url ||
    null;

  return {
    id,
    name: data.name || 'Unknown track',
    artists: String(artists).replace(/\u00a0/g, ' ').trim(),
    image,
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    embedUrl: `https://open.spotify.com/embed/track/${id}?utm_source=generator&theme=0`,
  };
}

function playlistImageFromPathfinder(playlist) {
  const items = playlist?.images?.items;
  if (Array.isArray(items) && items[0]) {
    const sources = items[0].sources || [];
    return (
      sources.find((s) => s?.width >= 300)?.url ||
      sources[0]?.url ||
      items[0].url ||
      null
    );
  }

  const vi = playlist?.visualIdentity?.image;
  if (Array.isArray(vi) && vi[0]?.url) return vi[0].url;
  return null;
}

async function pathfinderFetch(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'app-platform': 'WebPlayer',
      'User-Agent': UA,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => null);

  if (res.status === 401) {
    const err = new Error('Spotify session expired.');
    err.status = 401;
    err.code = 'TOKEN_EXPIRED';
    throw err;
  }

  if (!body || body.errors) {
    const msg = body?.errors?.[0]?.message || `Pathfinder error (${res.status})`;
    const err = new Error(msg);
    err.status = 502;
    err.code = msg === 'PersistedQueryNotFound' ? 'HASH_ROTATED' : 'PATHFINDER';
    err.details = body?.errors;
    throw err;
  }

  return body;
}

async function fetchPlaylistViaPathfinder(playlistId) {
  let token = await getAnonymousToken();
  let offset = 0;
  let total = Infinity;
  let meta = null;
  const tracks = [];
  const seen = new Set();

  while (offset < total) {
    let body;
    try {
      body = await pathfinderFetch(
        buildPlaylistQueryUrl(playlistId, offset, PAGE_SIZE),
        token
      );
    } catch (err) {
      if (err.code === 'TOKEN_EXPIRED') {
        invalidateToken();
        token = await getAnonymousToken();
        body = await pathfinderFetch(
          buildPlaylistQueryUrl(playlistId, offset, PAGE_SIZE),
          token
        );
      } else {
        throw err;
      }
    }

    const playlist = body?.data?.playlistV2;
    if (!playlist || playlist.__typename === 'NotFound' || !playlist.content) {
      const err = new Error(
        'Playlist not found or not public. Check the link and that the playlist is public.'
      );
      err.status = 404;
      throw err;
    }

    if (!meta) {
      meta = {
        id: playlistId,
        name: playlist.name || 'Playlist',
        description: playlist.description || '',
        image: playlistImageFromPathfinder(playlist),
        owner:
          playlist.ownerV2?.data?.name ||
          playlist.ownerV2?.data?.username ||
          '',
        spotifyUrl: `https://open.spotify.com/playlist/${playlistId}`,
        totalFromSpotify: playlist.content.totalCount ?? 0,
      };
    }

    total = playlist.content.totalCount ?? 0;
    const items = playlist.content.items || [];
    if (!items.length) break;

    for (const row of items) {
      const t = trackFromPathfinderRow(row);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push(t);
    }

    offset += items.length;
    if (items.length < PAGE_SIZE) break;

    if (offset > 50_000) break;
  }

  return {
    ...meta,
    source: 'pathfinder',
    tracks,
  };
}

async function fetchPlaylistViaEmbed(playlistId) {
  const html = await fetchEmbedHtml('playlist', playlistId);
  const next = parseNextData(html);
  const entity = next?.props?.pageProps?.state?.data?.entity;

  if (!entity || !Array.isArray(entity.trackList)) {
    const err = new Error(
      'No songs found. The playlist may be private, empty, or not shareable publicly.'
    );
    err.status = 404;
    throw err;
  }

  const tracks = [];
  const seen = new Set();
  for (const item of entity.trackList) {
    if (!item || item.entityType === 'episode') continue;
    const id =
      typeof item.uri === 'string' ? item.uri.split(':').pop() : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tracks.push({
      id,
      name: item.title || 'Unknown track',
      artists: String(item.subtitle || 'Unknown artist')
        .replace(/\u00a0/g, ' ')
        .trim(),
      image: null,
      spotifyUrl: `https://open.spotify.com/track/${id}`,
      embedUrl: `https://open.spotify.com/embed/track/${id}?utm_source=generator&theme=0`,
    });
  }

  const cover =
    entity.coverArt?.sources?.find((s) => s?.url)?.url ||
    entity.coverArt?.sources?.[0]?.url ||
    null;

  return {
    id: entity.id || playlistId,
    name: entity.title || entity.name || 'Playlist',
    description: '',
    image: cover,
    owner: entity.subtitle || entity.authors?.[0]?.name || '',
    spotifyUrl: `https://open.spotify.com/playlist/${playlistId}`,
    totalFromSpotify: tracks.length,
    source: 'embed',
    tracks,
  };
}

async function fetchPublicPlaylist(playlistId) {
  try {
    const full = await fetchPlaylistViaPathfinder(playlistId);
    if (full.tracks.length >= 2) return full;

  } catch {
  }

  return fetchPlaylistViaEmbed(playlistId);
}

async function fetchTrackPreview(trackId) {
  const id = String(trackId || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!id) {
    const err = new Error('Invalid track id');
    err.status = 400;
    throw err;
  }

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        cookieJar = '';
        cookieJarAt = 0;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
      const html = await fetchEmbedHtml('track', id);
      const next = parseNextData(html);
      const entity = next?.props?.pageProps?.state?.data?.entity;
      const previewUrl = extractPreviewUrlFromHtml(html, next);

      if (previewUrl) {
        return {
          id,
          name: entity?.title || entity?.name || null,
          previewUrl,
          spotifyUrl: `https://open.spotify.com/track/${id}`,
        };
      }

      lastErr = new Error('No preview available for this track.');
      lastErr.status = 404;
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr || new Error('No preview available for this track.');
}

export {
  extractPlaylistId,
  fetchPublicPlaylist,
  fetchPlaylistViaPathfinder,
  fetchPlaylistViaEmbed,
  fetchTrackPreview,
};
