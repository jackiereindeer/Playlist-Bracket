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
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/playlist', async (req, res) => {
  try {
    const playlistId = extractPlaylistId(req.query.url || req.query.id || '');
    if (!playlistId) {
      return res.status(400).json({
        error: 'Invalid playlist link. Paste a Spotify playlist URL (must be public).',
      });
    }

    const playlist = await fetchPublicPlaylist(playlistId);

    if (playlist.tracks.length < 2) {
      return res.status(400).json({
        error: 'Need at least 2 playable songs in the playlist to run a tournament.',
      });
    }

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
    const data = await fetchTrackPreview(req.params.trackId);
    if (!data.previewUrl) {
      return res.status(404).json({
        error: 'No preview available for this track.',
        id: data.id,
        previewUrl: null,
      });
    }
    res.json(data);
  } catch (err) {
    console.error('[api/preview]', err.message);
    res.status(err.status || 500).json({
      error: err.message || 'Could not load preview.',
    });
  }
});

const distPath = path.join(root, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(distPath, 'index.html'), (err) => {
    if (err) next();
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
