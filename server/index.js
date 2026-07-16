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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const isProd = process.env.NODE_ENV === 'production';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '32kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/playlist', async (req, res) => {
  try {
    const raw = String(req.query.url || req.query.id || '').slice(0, 500);
    const playlistId = extractPlaylistId(raw);
    if (!playlistId) {
      return res.status(400).json({
        error: 'Invalid playlist link. Paste a Spotify playlist URL (must be public).',
      });
    }

    const playlist = await fetchPublicPlaylist(playlistId);

    if (!playlist?.tracks || playlist.tracks.length < 2) {
      return res.status(400).json({
        error: 'Need at least 2 playable songs in the playlist to run a tournament.',
      });
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
