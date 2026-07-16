# Playlist Bracket

Paste a **public Spotify playlist** link and run a March Madness–style **1v1 song tournament**.  
You pick the winner of each match until one song remains.

**No Spotify login required for players.**  
The site loads **full** public playlists the same way many bots/tools do: an anonymous session from Spotify’s public embed pages + the web player’s playlist API with **pagination** (not capped at ~100).

---

## Features

- One match at a time
- **Playlist order** (1st vs 2nd, 3rd vs 4th, …) or **shuffle**
- Odd counts: last unpaired song advances automatically that round
- Title, artist, and Spotify embed player per song
- Results screen: playlist name + art, champion, full bracket
- Share / copy results summary
- **No user Spotify login**

---

## Run locally

You need [Node.js](https://nodejs.org/) (LTS).

```powershell
cd "C:\Users\braej\blight website"
npm.cmd install
npm.cmd run dev
```

Open **http://localhost:5173** in your browser.

| Process | Port | Role |
|--------|------|------|
| Vite (frontend) | 5173 | The website UI |
| Express (API) | 3001 | Loads public playlist data |

Stop with `Ctrl+C`.

### Production-style local run

```powershell
npm.cmd run build
$env:NODE_ENV="production"
npm.cmd start
```

Then open **http://localhost:3001**.

---

## Spotify setup

**You do not need** Client ID, Client Secret, or redirect URIs for playlist loading anymore.

Playlists must still be **public** on Spotify:

1. Open the playlist in Spotify  
2. **…** → make sure it is not private  
3. Share → copy link  
4. Paste into Playlist Bracket  

---

## How playlist loading works (no login)

| Method | Login? | Full playlists? |
|--------|--------|-----------------|
| Official Spotify Web API (Developer Mode) | Restricted | Usually **no** (403 on tracks) |
| Embed page only | No | **Capped ~100** |
| **Pathfinder + pagination (what we use)** | **No** | **Yes** — pages of 100 until complete |
| “Site-wide owner login for everyone” | One account on server | Only that account’s owned playlists |

This is the same general approach Discord-style tools use: public session token + paginated playlist contents. We then show official Spotify **track embeds** for listening.

**Caveats**

- Playlist must be **public** / shareable.  
- Spotify can rotate internal query hashes; we fall back to embed (capped) and can update the hash if needed.  
- Extremely large playlists (thousands of songs) take a few seconds to page through.

---

## Put the site on the internet (share with friends)

Your PC’s `localhost` is private. To get a public link, you **host** the app on a free cloud service.

**You do not need Spotify API keys** for this project.

### Recommended: [Render](https://render.com) (free tier)

1. Create a free account at [render.com](https://render.com).
2. Put this project on **GitHub** (see below).
3. Render → **New** → **Web Service** → connect the repo.
4. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
5. Deploy. Render gives you a URL like `https://playlist-bracket-xxxx.onrender.com`.
6. Share that link. Friends open it in any browser.

> Free Render apps **sleep** after ~15 minutes idle. First visit after sleep can take ~30–60 seconds.

### Alternative: [Railway](https://railway.app)

1. Sign up → **New Project** → **Deploy from GitHub**.
2. Build: `npm install && npm run build`
3. Start: `npm start`
4. Generate a public domain in the service settings.

### Put the code on GitHub first (required by most hosts)

1. Create a free account at [github.com](https://github.com).
2. Install [Git for Windows](https://gitforwindows.org/) if needed.
3. In PowerShell:

```powershell
cd "C:\Users\braej\blight website"
git init
git add .
git commit -m "Playlist Bracket ready to deploy"
```

4. On GitHub: **New repository** (don’t add a README).
5. Connect and push (GitHub will show the exact commands), roughly:

```powershell
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

Then connect that repo in Render/Railway.

### What the host runs

| Step | Command | What it does |
|------|---------|----------------|
| Build | `npm run build` | Builds the frontend into `dist/` |
| Start | `npm start` | Express serves the site + playlist API |

Port is automatic (`PORT` env var). No `.env` required.

---

## Open in VS Code

```powershell
code "C:\Users\braej\blight website"
```

---

## Project layout

```
├── server/index.js     # Loads public playlists via Spotify embed
├── src/main.js         # UI
├── src/tournament.js   # Bracket logic
├── src/style.css
└── package.json
```
