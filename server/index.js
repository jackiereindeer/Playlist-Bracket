import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractPlaylistId,
  fetchPublicPlaylist,
  fetchTrackPreview,
} from './spotify-public.js';
import {
  extractYouTubePlaylistId,
  isYouTubePlaylistUrl,
  fetchYouTubePlaylist,
  getApiKey as getYouTubeApiKey,
} from './youtube-public.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

const app = express();
const PORT = process.env.PORT || 3001;

// Render (and similar hosts) sit in front of Node as a reverse proxy.
// trust proxy makes req.ip use X-Forwarded-For so we see the visitor, not Render.
app.set('trust proxy', 1);

app.use(cors());
app.use(express.json({ limit: '32kb' }));

/**
 * Best-effort real visitor IP.
 * On Render, the browser → Render edge → your app, so the direct connection
 * is often a proxy. The original client is usually first in X-Forwarded-For.
 */
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  if (Array.isArray(xf) && xf[0]) {
    return String(xf[0]).split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

/** Paths we never log (health pings, etc.). */
const SKIP_VISIT_LOG = new Set(['/api/health']);

/** Static file extensions — logging every JS/CSS chunk would flood the logs. */
const STATIC_EXT =
  /\.(js|css|map|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|eot|mp3|mp4|webm)$/i;

/**
 * Option B visitor log: prints IP + method + path to stdout.
 * On Render → Dashboard → your service → Logs, search for "[visit]".
 * Does not store IPs in a database; lines age out with Render log retention.
 */
app.use((req, res, next) => {
  const pathOnly = req.path || '/';
  if (SKIP_VISIT_LOG.has(pathOnly) || STATIC_EXT.test(pathOnly)) {
    return next();
  }
  console.log(
    `[visit] ${new Date().toISOString()} ip=${clientIp(req)} ${req.method} ${pathOnly}`
  );
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    youtube: Boolean(getYouTubeApiKey()),
  });
});

app.get('/api/playlist', async (req, res) => {
  try {
    const raw = String(req.query.url || req.query.id || '').slice(0, 500);

    // YouTube playlist (list=… / PL…)
    if (isYouTubePlaylistUrl(raw)) {
      const ytId = extractYouTubePlaylistId(raw);
      if (!ytId) {
        return res.status(400).json({
          error: 'Invalid YouTube playlist link.',
        });
      }
      const playlist = await fetchYouTubePlaylist(ytId);
      res.set('Cache-Control', 'private, max-age=60');
      return res.json(playlist);
    }

    // Spotify playlist
    const playlistId = extractPlaylistId(raw);
    if (!playlistId) {
      return res.status(400).json({
        error:
          'Invalid playlist link. Paste a public Spotify or YouTube playlist URL.',
      });
    }

    const playlist = await fetchPublicPlaylist(playlistId);

    if (!playlist?.tracks || playlist.tracks.length < 2) {
      return res.status(400).json({
        error: 'Need at least 2 playable songs in the playlist to run a tournament.',
      });
    }

    // Normalize source tag for the client
    playlist.source = playlist.source || 'spotify';
    for (const t of playlist.tracks) {
      if (!t.source) t.source = 'spotify';
    }

    res.set('Cache-Control', 'private, max-age=60');
    res.json(playlist);
  } catch (err) {
    console.error('[api/playlist]', err.message, err.code || '', err.details || '');
    res.status(err.status || 500).json({
      error: err.message || 'Something went wrong loading the playlist.',
      code: err.code || undefined,
    });
  }
});

app.get('/api/preview/:trackId', async (req, res) => {
  try {
    const trackId = String(req.params.trackId || '').slice(0, 64);
    if (!/^[a-zA-Z0-9]+$/.test(trackId)) {
      return res.status(400).json({ error: 'Invalid track id.' });
    }

    const data = await fetchTrackPreview(trackId);
    if (!data.previewUrl) {
      return res.status(404).json({
        error: 'No preview available for this track.',
        id: data.id,
        previewUrl: null,
      });
    }
    // Previews are stable CDN URLs — short cache cuts repeat scrapes
    res.set('Cache-Control', 'public, max-age=300');
    res.json(data);
  } catch (err) {
    console.error('[api/preview]', err.message);
    res.status(err.status || 500).json({
      error: err.message || 'Could not load preview.',
    });
  }
});

const distPath = path.join(root, 'dist');
app.use(
  express.static(distPath, {
    // Avoid stale SPA shells after deploys; hashed assets still cache well
    maxAge: isProd ? '1h' : 0,
    index: false,
  })
);
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) {
      if (!res.headersSent) {
        res.status(404).type('text').send('Build the app first (npm run build), or use npm run dev.');
      } else {
        next(err);
      }
    }
  });
});

/**
 * Start the HTTP server. Used by CLI (`npm start`) and the Electron shell.
 * @param {{ port?: number|string, host?: string }} [opts]
 * @returns {Promise<{ server: import('http').Server, port: number, host: string }>}
 */
export function startServer(opts = {}) {
  const port = Number(opts.port || process.env.PORT || PORT) || 3001;
  const host = opts.host || process.env.HOST || '127.0.0.1';

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`Server running on http://${host}:${port}`);
      resolve({ server, port, host });
    });
    server.on('error', reject);
  });
}

// Auto-listen when run as `node server/index.js` (not when Electron imports us)
const isElectronManaged = process.env.PLAYLIST_BRACKET_MANAGED === '1';
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]).replace(/\\/g, '/').endsWith('/server/index.js');

if (!isElectronManaged && isDirectRun) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
