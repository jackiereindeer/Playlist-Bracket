# Playlist Bracket — Project Rules

**Product name:** Playlist Bracket  
**Folder name on disk:** `blight website` (casual/local name; keep package/product names as Playlist Bracket)  
**Owner:** braej  
**Stack:** Node 20+, Vite 8, Express, vanilla ES modules (no React/Vue), Electron 35 for Windows desktop, `ws` for multiplayer  

Cross-session human + AI memory lives outside this repo at:

`C:\Users\braej\AI-Context\START_HERE.md`  
`C:\Users\braej\AI-Context\CORE.md` — **how braej likes answers/help**  
`C:\Users\braej\AI-Context\projects\playlist-bracket.md` — **FULL product handoff (read on new sessions)**  

### 🚨 New session recovery

If chat context is empty/compacted: **immediately read**  
`C:\Users\braej\AI-Context\projects\playlist-bracket.md`  
Then pick up **as if nothing interrupted** — short proof summary, no re-onboarding, no full reteach. Continue the product work.

### Collaboration style (from CORE — do not skip)

- Owner is **not** a heavy coder → **over-explain** what/why/where in plain language.
- **Narrate while working** (what file you’re opening, what you’re about to change, build results).
- Support **VS Code follow-along**: paths, Ctrl+P / Ctrl+F targets, plain-English section descriptions after edits.
- Big features: interrogate first; piece-by-piece guides when asked.
- **Never `git push` / deploy to Render** unless braej gives clear specific confirmation (e.g. `push`, `push to GitHub now`). Live auto-deploys from `main`.

---

## What this app is

March Madness–style **1v1 song tournament** + **solo Rating Mode** + **party multiplayer** (bracket + **Group Rate**) from **public** Spotify or YouTube playlists.

### Solo Bracket

- Paste playlist → optional roster curate → pick winners → champion.  
- Win-beat full-screen after each pick (skippable checkbox for long lists).  
- Undo / 1–2 keys / random; localStorage save.  

### Solo Rating Mode

- Home → Rating Mode → roster → rate 0–10 (0.1 fine) + volume.  
- Undo stack; no overall average on results; ranked end screen.  
- Export text + PNG (`src/rating-export-image.js`).  
- Click header name/author/count to toggle inclusion on export image.  

### Party / multiplayer (SHIPPED to live)

- Home → **Play with friends** → host/join 6-char code or `?room=CODE`.  
- Kahoot-style **bracket** votes, timers, results; share link, custom PFPs, chat.  
- Lobby mode: **Bracket** vs **Group Rate**.  
- Server: `server/party/*` WebSocket **`/party`**. Client: `src/party/*`.  
- Spotify + YouTube mix; host playlist; optional guest single-track adds when `allowPartyAddSongs`.  
- Group Rate: lock-in ratings, auto-advance, X/Y privacy, DC-out, averages + matrix, continue-all to lobby, rematch, image export.  

**Never put the word “Blight” in product UI** (folder name only).

---

## Deploy / live site (critical)

| | |
|--|--|
| Live | https://playlist-bracket.onrender.com/ |
| GitHub | https://github.com/jackiereindeer/Playlist-Bracket |
| Auto-deploy | Push to `main` updates live |
| Live content | **Full app**: solo, rating, party bracket, Group Rate, export, etc. |
| Last handoff commit | `96d05b1` (results-meta-toggle off-state: dim, no purple strike) |
| Free tier | Cold starts expected |

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
│   ├── resolve-media.js
│   ├── party/             # multiplayer WS rooms (bracket + group rate)
│   ├── spotify-public.js
│   └── youtube-public.js
├── src/
│   ├── main.js            # solo + home + rating mode
│   ├── party/             # party-app.js, party-bracket.js
│   ├── tournament.js
│   ├── youtube-players.js
│   ├── preview-cache.js
│   ├── rating-export-image.js
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
2. **Server owns external playlist loading.** Frontend calls `GET /api/playlist?url=…` (and related preview/import routes). Don’t scrape Spotify/YouTube from the browser for playlist bulk data.
3. **Spotify playlists:** public, no user OAuth. Implementation is anonymous/public session + Pathfinder GraphQL with pagination (`PAGE_SIZE` 100). Hash may rot — update `FETCH_PLAYLIST_HASH` / fallbacks in `spotify-public.js` carefully. Official Web API developer credentials in `.env` are **legacy/optional**, not required for the current public path (see README).
4. **YouTube playlists:** require `YOUTUBE_API_KEY` (or `YT_API_KEY`) server-side. Cap is intentional (`MAX_ITEMS` in `youtube-public.js`). Quota ~10k/day — no bulk key rotation.
5. **Electron must import `startServer()`** from `server/index.js` (not double-listen). Server only auto-listens when run as `node server/index.js` and not `PLAYLIST_BRACKET_MANAGED=1`.
6. **Audio is delicate.** Match players, transition stingers, and champion bed are separate concerns. Don’t “fix” audio by nuking all media indiscriminately — preserve champion bed across results UI when that’s the intended behavior. Respect fade helpers and `renderGeneration` / `loadGeneration` guards against race conditions. Group Rate: soft HUD — re-renders must not kill audio.
7. **Long brackets (100+ songs):** Reuse body-level pool `<audio>` via `getPoolAudio` — do **not** put a fresh `<audio id="audio-a">` inside each match card. Creating new elements every match leaks `MediaElementSource` nodes and causes late-game lag. Shared `src/preview-cache.js` caps cached preview URLs; prune eliminated tracks. During winner beats, **prefetch** the next match’s preview URLs + art (solo + party).
8. **Party cleanup:** `partyHandle.destroy()` must remove the document paste listener, dispose `#party-audio` (disconnect MediaElementSource + remove node), cancel EQ/timer epochs, and close the WebSocket.
9. **Save format:** `localStorage` key `playlist-bracket-save-v1` (and rating-session keys as implemented). Validate with guards; corrupt saves fall back to setup, never crash the whole app.
10. **Secrets:** never commit `.env`, never put API keys in client bundles, don’t distribute portable exes that embed personal keys without warning the user.
11. **Full Spotify audio:** multiparty still uses previews unless a real Premium/OAuth or YouTube path is designed — don’t invent free full-track multiparty.
12. **PNG export:** use shared `buildRatingResultsImageBlob` in `rating-export-image.js`; respect `headerShow` / results-meta-toggle for title/author/count visibility. Off-state should stay **dimmed**, not light-purple strikethrough.

---

## Coding style for this repo

- ES modules (`"type": "module"`). Electron main is CommonJS (`.cjs`) on purpose.
- Prefer small pure helpers in `tournament.js`; keep DOM/audio orchestration in `main.js` / `party-app.js` unless a clear extract improves clarity.
- Match existing naming: `state`, `side` (`a`/`b`), `gen` (render generation), `volume01` (0–1).
- Escape untrusted strings for HTML (`escapeHtml`). Playlist titles/track names are untrusted.
- CSS: extend `style.css` stage variables / existing class patterns rather than introducing a second design system.
- Comments: explain non-obvious invariants (audio races, Spotify hash, Electron env paths), not obvious one-liners.
- Don’t drive-by refactor large files unless the task needs it — `main.js` and `party-app.js` are large by design.
- PowerShell: prefer simple `git commit -m "msg"` (HEREDOC often fails on Windows).

---

## Product behavior invariants (don’t break casually)

- One match at a time for brackets (with region/bracket structure in tournament state).
- Seeding: playlist order **or** shuffle.
- Odd count → bye (prefer songs that have had fewer byes).
- Results: champion + shareable summary; rating results ranked; Group Rate averages + matrix.
- Round transitions and stage vibe should still feel intentional after UI changes.
- Public Spotify only; clear errors for private/invalid links.
- Group Rate: disconnect = out for that run; no late raters mid-session; continue-all returns to same-room lobby.

---

## Testing / verification

There is no formal test suite yet. Before claiming done:

1. `npm.cmd run build` succeeds.
2. Manual smoke: paste a small public Spotify playlist → play a match → pick winner → confirm transition + next match; if YouTube key present, spot-check a YT playlist.
3. If touching save/load: refresh mid-tournament and confirm resume.
4. If touching party: multi-tab host+guest smoke (join, vote or Group Rate, chat).
5. If touching Electron: at least `desktop` or `dist:portable` still starts the window + health.
6. If touching export: check PNG header toggles and Group Rate averages on art.

---

## Deploy notes

- Host runs `npm install && npm run build` then `npm start` (Express serves `dist/` + API).
- Free hosts (e.g. Render) sleep; cold start is expected.
- Spotify API keys not required for public playlist path; YouTube needs a key if that source matters in production (already on Render).

---

## When unsure

Prefer reading `src/main.js`, `src/party/party-app.js`, `src/tournament.js`, and `server/**/*.js` over guessing.  
Update this file and `C:\Users\braej\AI-Context\projects\playlist-bracket.md` when architecture or product decisions change.
