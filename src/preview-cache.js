/**
 * Shared Spotify preview URL cache (solo + party).
 * Fetching `/api/preview/:id` is the slow part (server scrape) — cache it
 * and warm the CDN during winner transitions so the next match feels instant.
 */

const cache = Object.create(null);
const inflight = Object.create(null);

/** Keep a small hot set — not every song ever heard. */
const MAX_CACHED_PREVIEWS = 48;

export function getCachedPreviewUrl(trackId) {
  if (!trackId) return null;
  return cache[trackId] || null;
}

export function dropPreview(trackId) {
  if (!trackId) return;
  delete cache[trackId];
  delete inflight[trackId];
}

export function clearPreviewCache() {
  for (const key of Object.keys(cache)) delete cache[key];
  for (const key of Object.keys(inflight)) delete inflight[key];
}

export function trimPreviewCache() {
  const keys = Object.keys(cache);
  if (keys.length <= MAX_CACHED_PREVIEWS) return;
  for (const id of keys.slice(0, keys.length - MAX_CACHED_PREVIEWS)) {
    delete cache[id];
  }
}

/**
 * Drop cache entries for eliminated tracks (optionally force-keep some ids).
 * @param {Set<string>|string[]} eliminatedIds
 * @param {Set<string>|string[]} [keepIds]
 */
export function dropEliminatedPreviews(eliminatedIds, keepIds) {
  const elim =
    eliminatedIds instanceof Set ? eliminatedIds : new Set(eliminatedIds || []);
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  for (const id of Object.keys(cache)) {
    if (elim.has(id) && !keep.has(id)) delete cache[id];
  }
  trimPreviewCache();
}

/**
 * Hard prune: only keep listed ids (aggressive — prefer dropEliminatedPreviews).
 * @param {Set<string>|string[]} keepIds
 */
export function prunePreviewCache(keepIds) {
  const keep = keepIds instanceof Set ? keepIds : new Set(keepIds || []);
  for (const id of Object.keys(cache)) {
    if (!keep.has(id)) delete cache[id];
  }
  trimPreviewCache();
}

/**
 * Resolve a Spotify preview URL (cached, de-duped in-flight).
 * @returns {Promise<string|null>}
 */
export async function ensurePreviewUrl(trackId) {
  if (!trackId) return null;
  if (cache[trackId]) return cache[trackId];
  if (inflight[trackId]) return inflight[trackId];

  inflight[trackId] = (async () => {
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, 400));
          }
          const res = await fetch(`/api/preview/${encodeURIComponent(trackId)}`);
          const data = await res.json().catch(() => ({}));
          if (res.ok && data.previewUrl) {
            cache[trackId] = data.previewUrl;
            trimPreviewCache();
            return data.previewUrl;
          }
        } catch {
          // retry once
        }
      }
      return null;
    } finally {
      delete inflight[trackId];
    }
  })();

  return inflight[trackId];
}

/** Warm browser HTTP cache for a media URL (no playback, no Web Audio). */
export function warmMediaUrl(url) {
  if (!url || typeof url !== 'string') return;
  try {
    fetch(url, { mode: 'cors', cache: 'force-cache', credentials: 'omit' }).catch(
      () => {}
    );
  } catch {
  }
}

/** Prefetch album art so the next match paint isn’t blank-then-pop. */
export function prefetchImage(src) {
  if (!src || typeof src !== 'string') return;
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
  } catch {
  }
}

/**
 * During winner celebration: resolve + warm next match previews + art.
 * @param {{ a?: { id?: string, image?: string }, b?: { id?: string, image?: string } }|null} match
 */
export function prefetchMatchPreviews(match) {
  if (!match) return;
  for (const side of ['a', 'b']) {
    const song = match[side];
    if (!song?.id) continue;
    prefetchImage(song.image);
    ensurePreviewUrl(song.id).then((url) => {
      if (url) warmMediaUrl(url);
    });
  }
}

/**
 * Prefetch a single song (transition stinger, champion, etc.).
 */
export function prefetchSongPreview(song) {
  if (!song?.id) return;
  prefetchImage(song.image);
  ensurePreviewUrl(song.id).then((url) => {
    if (url) warmMediaUrl(url);
  });
}
