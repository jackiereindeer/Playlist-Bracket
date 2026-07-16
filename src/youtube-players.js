/**
 * YouTube IFrame API helpers for match / champion / transition playback.
 */

const players = new Map(); // side -> YT.Player
let apiPromise = null;

export function isYouTubeTrack(song) {
  return Boolean(
    song &&
      (song.source === 'youtube' ||
        song.youtubeId ||
        (typeof song.id === 'string' &&
          song.id.length === 11 &&
          song.youtubeUrl))
  );
}

export function youtubeVideoId(song) {
  if (!song) return null;
  if (song.youtubeId) return song.youtubeId;
  if (song.source === 'youtube' && song.id) return song.id;
  return null;
}

export function loadYouTubeApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.YT && typeof window.YT.Player === 'function') {
    return Promise.resolve(window.YT);
  }
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        if (typeof prior === 'function') prior();
      } catch {
      }
      if (window.YT && typeof window.YT.Player === 'function') resolve(window.YT);
      else reject(new Error('YouTube API failed to load'));
    };

    if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      document.head.appendChild(tag);
    }

    // Already racing past ready
    if (window.YT && typeof window.YT.Player === 'function') {
      resolve(window.YT);
    }
  });

  return apiPromise;
}

export function destroyYouTubePlayer(side) {
  const p = players.get(side);
  if (!p) return;
  try {
    p.stopVideo?.();
  } catch {
  }
  try {
    p.destroy?.();
  } catch {
  }
  players.delete(side);
}

export function destroyAllYouTubePlayers() {
  for (const side of [...players.keys()]) {
    destroyYouTubePlayer(side);
  }
}

export function getYouTubePlayer(side) {
  return players.get(side) || null;
}

export function pauseAllYouTubeExcept(exceptSide = null) {
  for (const [side, p] of players) {
    if (exceptSide && side === exceptSide) continue;
    try {
      const st = p.getPlayerState?.();
      // 1 = playing
      if (st === 1 || st === 3) p.pauseVideo?.();
    } catch {
    }
  }
}

/**
 * Create (or recreate) a player in #yt-{side}.
 * hostEl must exist in the DOM.
 */
export async function mountYouTubePlayer(side, videoId, {
  volume01 = 0.25,
  autoplay = false,
  onPlaying,
  onPaused,
  onEnded,
  onReady,
} = {}) {
  if (!videoId || !side) return null;
  const host = document.getElementById(`yt-${side}`);
  if (!host) return null;

  await loadYouTubeApi();
  destroyYouTubePlayer(side);

  // Fresh mount node (destroy may remove the old iframe host)
  let mount = document.getElementById(`yt-${side}`);
  if (!mount) return null;
  mount.innerHTML = '';
  const inner = document.createElement('div');
  inner.id = `yt-${side}-inner`;
  mount.appendChild(inner);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (player) => {
      if (settled) return;
      settled = true;
      resolve(player);
    };

    const player = new window.YT.Player(inner.id, {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: {
        autoplay: autoplay ? 1 : 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        iv_load_policy: 3,
        cc_load_policy: 0,
        origin: window.location.origin,
      },
      events: {
        onReady: (e) => {
          players.set(side, e.target);
          try {
            e.target.setVolume(Math.round(Math.min(1, Math.max(0, volume01)) * 100));
          } catch {
          }
          if (autoplay) {
            try {
              e.target.playVideo();
            } catch {
            }
          }
          onReady?.(e.target);
          finish(e.target);
        },
        onStateChange: (e) => {
          // -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
          if (e.data === 1) onPlaying?.();
          else if (e.data === 2) onPaused?.();
          else if (e.data === 0) onEnded?.();
        },
        onError: () => {
          finish(players.get(side) || null);
        },
      },
    });

    // Fallback if onReady never fires
    setTimeout(() => finish(players.get(side) || player || null), 8000);
  });
}

export function setYouTubeVolume(side, volume01) {
  const p = players.get(side);
  if (!p) return;
  try {
    p.setVolume(Math.round(Math.min(1, Math.max(0, volume01)) * 100));
    if (volume01 <= 0.001) p.mute?.();
    else p.unMute?.();
  } catch {
  }
}

export function youtubeIsPlaying(side) {
  const p = players.get(side);
  if (!p) return false;
  try {
    return p.getPlayerState?.() === 1;
  } catch {
    return false;
  }
}

export async function playYouTube(side) {
  const p = players.get(side);
  if (!p) return false;
  try {
    p.playVideo();
    return true;
  } catch {
    return false;
  }
}

export function pauseYouTube(side) {
  const p = players.get(side);
  if (!p) return;
  try {
    p.pauseVideo();
  } catch {
  }
}
