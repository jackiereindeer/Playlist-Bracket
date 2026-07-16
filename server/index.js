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
import { attachPartyHub } from './party/hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

const app = express();
const PORT = process.env.PORT || 3001;

/** Set true only when you intentionally deploy party online. Local multi-tab works either way. */
const PARTY_ENABLED = process.env.PARTY_ENABLED !== '0';

app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    youtube: Boolean(getYouTubeApiKey()),
    party: PARTY_ENABLED,
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
  // Local/Electron: loopback. Render/production: all interfaces so friends can connect.
  const host =
    opts.host ||
    process.env.HOST ||
    (isProd ? '0.0.0.0' : '127.0.0.1');

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      console.log(`Server running on http://${host}:${port}`);
      if (PARTY_ENABLED) {
        try {
          attachPartyHub(server);
          console.log(
            `[party] Multiplayer ready — WebSocket path /party on ${host}:${port}`
          );
        } catch (err) {
          console.error('[party] failed to start hub:', err.message);
        }
      }
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
