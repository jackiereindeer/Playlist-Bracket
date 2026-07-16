# Playlist Bracket — Project Rules

**Product name:** Playlist Bracket  
**Folder name on disk:** `blight website` (casual/local name; keep package/product names as Playlist Bracket)  
**Owner:** braej  
**Stack:** Node 20+, Vite 8, Express, vanilla ES modules (no React/Vue), Electron 35 for Windows desktop  

Cross-session human + AI memory lives outside this repo at:

`C:\Users\braej\AI-Context\START_HERE.md`  
`C:\Users\braej\AI-Context\CORE.md` — **how braej likes answers/help**  
`C:\Users\braej\AI-Context\projects\playlist-bracket.md` — full product/party/go-live notes  

Read those when starting a fresh session. This file is the **in-repo** source of truth for how to work *in this codebase*.

### Collaboration style (from CORE — do not skip)

- Owner is **not** a heavy coder → **over-explain** what/why/where in plain language.
- **Narrate while working** (what file you’re opening, what you’re about to change, build results).
- Support **VS Code follow-along**: paths, Ctrl+P / Ctrl+F targets, plain-English section descriptions after edits.
- Big features: interrogate first; piece-by-piece guides when asked.
- **Never `git push` / deploy to Render** unless braej gives clear specific confirmation (e.g. `push party to GitHub now`). Live auto-deploys from `main`.

---

## What this app is

March Madness–style **1v1 song tournament** from a **public** Spotify or YouTube playlist.

### Solo (also what’s live on Render today)

- Paste playlist → pick winners → champion.  
- Win-beat full-screen after each pick (skippable checkbox for long lists).  
- Undo / 1–2 keys / random; localStorage save.

### Party (local only until explicit push)

- Home → **Play with friends** → host/join 6-char code.  
- Kahoot-style votes, sync or desync play, timers, results with brackets.  
- Server: `server/party/*` WebSocket **`/party`**. Client: `src/party/*`.  
- Party playlists: **Spotify-only** for now.

**Never put the word “Blight” in product UI** (folder name only).

---

## Deploy / live site (critical)

| | |
|--|--|
| Live | https://playlist-bracket.onrender.com/ |
| GitHub | https://github.com/jackiereindeer/Playlist-Bracket |
| Auto-deploy | Push to `main` updates live |
| Live content | **Solo only** until braej ships party |
| Before party push | Share link + **custom PFPs** + checklist in AI-Context project note |

---

## Layout (do not invent new top-level structure without reason)

```
blight website/
├── AGENTS.md
├── README.md
├── package.json
├── vite.config.js         # :5173, proxies /api + /party → :3001
├── index.html
├── .env                   # gitignored — never commit
├── electron/main.cjs
├── server/
│   ├── index.js           # API + startServer() + party hub attach
│   ├── party/             # multiplayer WS rooms
│   ├── spotify-public.js
│   └── youtube-public.js
├── src/
│   ├── main.js            # solo + home mode switch
│   ├── party/             # party-app.js, party-bracket.js
│   ├── tournament.js
│   ├── youtube-players.js
│   ├── scope.js
│   └── style.css
├── public/
├── dist/
└── release/
```

---

## Commands (Windows / PowerShell)

Work from the project root. Prefer `npm.cmd` if plain `npm` is flaky on PATH.

| Goal | Command |
|------|---------|
| Dev (API + Vite) | `npm.cmd run dev` |
| API only | `npm.cmd run dev:server` |
| Web only | `npm.cmd run dev:web` |
| Production build | `npm.cmd run build` |
| Serve production locally | `$env:NODE_ENV="production"; npm.cmd start` → http://localhost:3001 |
| Desktop after build | `npm.cmd run desktop` |
| Portable Windows exe | `npm.cmd run dist:portable` |

**Ports**

| Service | Port |
|---------|------|
| Vite dev UI | 5173 |
| Express API (dev/prod CLI) | 3001 |
| Electron managed server | 3847 (avoids clashing with dev) |

Vite proxies `/api/*` and WebSocket `/party` → `http://localhost:3001` / `ws://localhost:3001`.

---

## Architecture rules

1. **Keep vanilla JS.** No framework migration unless the user explicitly asks.
2. **Server owns external playlist loading.** Frontend calls `GET /api/playlist?url=…` (and related preview routes). Don’t scrape Spotify/YouTube from the browser for playlist bulk data.
3. **Spotify playlists:** public, no user OAuth. Implementation is anonymous/public session + Pathfinder GraphQL with pagination (`PAGE_SIZE` 100). Hash may rot — update `FETCH_PLAYLIST_HASH` / fallbacks in `spotify-public.js` carefully. Official Web API developer credentials in `.env` are **legacy/optional**, not required for the current public path (see README).
4. **YouTube playlists:** require `YOUTUBE_API_KEY` (or `YT_API_KEY`) server-side. Cap is intentional (`MAX_ITEMS` in `youtube-public.js`).
5. **Electron must import `startServer()`** from `server/index.js` (not double-listen). Server only auto-listens when run as `node server/index.js` and not `PLAYLIST_BRACKET_MANAGED=1`.
6. **Audio is delicate.** Match players, transition stingers, and champion bed are separate concerns. Don’t “fix” audio by nuking all media indiscriminately — preserve champion bed across results UI when that’s the intended behavior. Respect fade helpers and `renderGeneration` / `loadGeneration` guards against race conditions.
7. **Long brackets (100+ songs):** Reuse body-level pool `<audio>` via `getPoolAudio` — do **not** put a fresh `<audio id="audio-a">` inside each match card. Creating new elements every match leaks `MediaElementSource` nodes and causes late-game lag. Prune `previewCache` for eliminated tracks; keep `MAX_CACHED_PREVIEWS` small.
7. **Save format:** `localStorage` key `playlist-bracket-save-v1`. Validate with `isSongLike` / deserialize guards; corrupt saves fall back to setup, never crash the whole app.
8. **Secrets:** never commit `.env`, never put API keys in client bundles, don’t distribute portable exes that embed personal keys without warning the user.

---

## Coding style for this repo

- ES modules (`"type": "module"`). Electron main is CommonJS (`.cjs`) on purpose.
- Prefer small pure helpers in `tournament.js`; keep DOM/audio orchestration in `main.js` unless a clear extract improves clarity.
- Match existing naming: `state`, `side` (`a`/`b`), `gen` (render generation), `volume01` (0–1).
- Escape untrusted strings for HTML (`escapeHtml`). Playlist titles/track names are untrusted.
- CSS: extend `style.css` stage variables / existing class patterns rather than introducing a second design system.
- Comments: explain non-obvious invariants (audio races, Spotify hash, Electron env paths), not obvious one-liners.
- Don’t drive-by refactor large files unless the task needs it — `main.js` is large by design.

---

## Product behavior invariants (don’t break casually)

- One match at a time (with region/bracket structure in tournament state).
- Seeding: playlist order **or** shuffle.
- Odd count → bye (prefer songs that have had fewer byes).
- Results: champion + shareable summary.
- Round transitions and stage vibe should still feel intentional after UI changes.
- Public Spotify only; clear errors for private/invalid links.

---

## Testing / verification

There is no formal test suite yet. Before claiming done:

1. `npm.cmd run build` succeeds.
2. Manual smoke: paste a small public Spotify playlist → play a match → pick winner → confirm transition + next match; if YouTube key present, spot-check a YT playlist.
3. If touching save/load: refresh mid-tournament and confirm resume.
4. If touching Electron: at least `desktop` or `dist:portable` still starts the window + health.

---

## Deploy notes (from README)

- Host runs `npm install && npm run build` then `npm start` (Express serves `dist/` + API).
- Free hosts (e.g. Render) sleep; cold start is expected.
- Spotify API keys not required for public playlist path; YouTube needs a key if that source matters in production.

---

## When unsure

Prefer reading `src/main.js`, `src/tournament.js`, and `server/*.js` over guessing. Update this file and `C:\Users\braej\AI-Context\projects\playlist-bracket.md` when architecture or product decisions change.
