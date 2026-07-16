/**
 * Bracket HTML for party results (same structure/CSS as solo).
 * Copied/adapted so party doesn't import main.js.
 */

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mmCoverHtml(song, role) {
  if (!song) return '';
  const tip = `${song.name || ''}${song.artists ? ` — ${song.artists}` : ''}`;
  const inner = song.image
    ? `<img src="${esc(song.image)}" alt="" loading="lazy" draggable="false" />`
    : `<span class="mm-fallback" aria-hidden="true">🎵</span>`;
  return `
    <div class="mm-cover mm-${role}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">
      <div class="mm-cover-inner">${inner}</div>
    </div>`;
}

function mmMatchHtml(m) {
  if (!m?.a || !m?.b) return '';
  const aWin = m.winnerId === m.a.id;
  return `
    <div class="mm-match">
      ${mmCoverHtml(m.a, aWin ? 'winner' : 'loser')}
      <span class="mm-vs" aria-hidden="true">vs</span>
      ${mmCoverHtml(m.b, aWin ? 'loser' : 'winner')}
    </div>`;
}

function groupHistoryByRound(history) {
  const byRound = new Map();
  for (const m of history) {
    const key = m.round ?? 1;
    if (!byRound.has(key)) byRound.set(key, []);
    byRound.get(key).push(m);
  }
  return [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((round) => ({ round, matches: byRound.get(round) }));
}

function labelForRoundMatches(matches, initialCount) {
  if (!matches?.length) return 'Round';
  if (matches.some((m) => m.region === 'final')) return 'Final';
  if (matches.every((m) => m.region === 'cross')) return 'Play-in';
  const songs = matches.length * 2;
  if (songs === 2) return 'Final';
  if (songs === 4) return 'Semifinals';
  if (songs === 8) return 'Quarterfinals';
  if (songs === 16) return 'Round of 16';
  if (songs === 32) return 'Round of 32';
  if (songs === 64) return 'Round of 64';
  if (initialCount && songs + 2 >= initialCount && songs <= initialCount) {
    return `${initialCount} songs`;
  }
  if (songs > 2) return `Round of ${songs}`;
  return `Wave ${matches[0].round}`;
}

function mmRoundColumn(matches, label, sideClass = '') {
  if (!matches.length) return '';
  const densityHint =
    matches.length > 16 ? 'mm-dense' : matches.length > 8 ? 'mm-mid' : '';
  return `
    <div class="mm-round ${sideClass} ${densityHint}">
      <div class="mm-round-label">${esc(label)}</div>
      <div class="mm-round-matches">${matches.map(mmMatchHtml).join('')}</div>
    </div>`;
}

function partitionBracketHistory(history) {
  const leftByWave = new Map();
  const rightByWave = new Map();
  const crossByWave = new Map();
  const finals = [];
  for (const m of history) {
    if (m.region === 'final') {
      finals.push(m);
      continue;
    }
    if (m.region === 'cross') {
      if (!crossByWave.has(m.round)) crossByWave.set(m.round, []);
      crossByWave.get(m.round).push(m);
      continue;
    }
    const map = m.region === 'right' ? rightByWave : leftByWave;
    if (!map.has(m.round)) map.set(m.round, []);
    map.get(m.round).push(m);
  }
  return {
    leftByWave,
    rightByWave,
    crossByWave,
    finals,
    leftWaves: [...leftByWave.keys()].sort((a, b) => a - b),
    rightWaves: [...rightByWave.keys()].sort((a, b) => a - b),
  };
}

function buildClassicBracketView(history, champion, initialCount) {
  const parts = partitionBracketHistory(history);
  const leftCols = parts.leftWaves
    .map((w) =>
      mmRoundColumn(
        parts.leftByWave.get(w),
        labelForRoundMatches(parts.leftByWave.get(w), initialCount),
        'mm-side-left'
      )
    )
    .join('');
  const rightCols = [...parts.rightWaves]
    .reverse()
    .map((w) =>
      mmRoundColumn(
        parts.rightByWave.get(w),
        labelForRoundMatches(parts.rightByWave.get(w), initialCount),
        'mm-side-right'
      )
    )
    .join('');
  const finalMatch = parts.finals[parts.finals.length - 1];
  const center = `
    <div class="mm-center">
      ${
        finalMatch
          ? `<div class="mm-round mm-final-round"><div class="mm-round-label">Final</div>
             <div class="mm-round-matches">${mmMatchHtml(finalMatch)}</div></div>`
          : ''
      }
      ${
        champion
          ? `<div class="mm-round mm-champ-round"><div class="mm-round-label">Champion</div>
             <div class="mm-round-matches"><div class="mm-match mm-champ-match">
               ${mmCoverHtml(champion, 'winner')}<span class="mm-champ-crown">🏆</span>
             </div></div></div>`
          : ''
      }
    </div>`;
  return `
    <div class="mm-bracket-scroll">
      <div class="mm-bracket mm-classic">
        <div class="mm-half mm-half-left">${leftCols}</div>
        ${center}
        <div class="mm-half mm-half-right">${rightCols}</div>
      </div>
    </div>`;
}

function roundListHtml(matches, label) {
  if (!matches.length) return '<p class="muted small">No matches.</p>';
  const items = matches
    .map((m) => {
      const aWin = m.winnerId === m.a.id;
      return `
        <div class="round-list-match round-list-match-lg">
          <div class="round-list-side ${aWin ? 'is-winner' : 'is-loser'}">
            ${mmCoverHtml(m.a, aWin ? 'winner' : 'loser')}
            <div class="round-list-text">
              <strong>${esc(m.a.name)}</strong>
              <span>${esc(m.a.artists || '')}</span>
            </div>
          </div>
          <span class="round-list-vs">vs</span>
          <div class="round-list-side ${aWin ? 'is-loser' : 'is-winner'}">
            ${mmCoverHtml(m.b, aWin ? 'loser' : 'winner')}
            <div class="round-list-text">
              <strong>${esc(m.b.name)}</strong>
              <span>${esc(m.b.artists || '')}</span>
            </div>
          </div>
        </div>`;
    })
    .join('');
  return `
    <div class="round-list round-list-single">
      <h4 class="round-list-heading round-list-heading-solo">
        ${esc(label)} <span>${matches.length} match${matches.length === 1 ? '' : 'es'}</span>
      </h4>
      <div class="round-list-matches">${items}</div>
    </div>`;
}

export function buildPartyBracketHtml(history, champion, initialCount) {
  if (!history?.length) {
    return '<p class="muted small">No matches recorded.</p>';
  }
  const waves = groupHistoryByRound(history);
  const roundTabs = waves.map((w) => ({
    id: `round-${w.round}`,
    label: labelForRoundMatches(w.matches, initialCount),
    matches: w.matches,
  }));
  const tabs = [...roundTabs, { id: 'bracket-view', label: 'Bracket view', matches: null }];
  const defaultTab = tabs[0]?.id || 'bracket-view';
  const tabBar = tabs
    .map(
      (t) => `
      <button type="button" class="bracket-tab${t.id === defaultTab ? ' is-active' : ''}"
        data-bracket-tab="${t.id}" role="tab"
        aria-selected="${t.id === defaultTab ? 'true' : 'false'}">${esc(t.label)}</button>`
    )
    .join('');
  const roundPanels = roundTabs
    .map(
      (t) => `
      <div class="bracket-panel" data-bracket-panel="${t.id}" role="tabpanel"
        ${t.id === defaultTab ? '' : 'hidden'}>
        ${roundListHtml(t.matches, t.label)}
      </div>`
    )
    .join('');
  const classic = `
    <div class="bracket-panel" data-bracket-panel="bracket-view" role="tabpanel" hidden>
      <p class="bracket-hint muted small">Full dual-region bracket — scroll if needed.</p>
      ${buildClassicBracketView(history, champion, initialCount)}
    </div>`;
  return `
    <div class="bracket-explorer" id="party-bracket-explorer">
      <div class="bracket-tabs" role="tablist">${tabBar}</div>
      <div class="bracket-panels">${roundPanels}${classic}</div>
    </div>`;
}

export function wirePartyBracketTabs(root) {
  if (!root) return;
  const tabs = [...root.querySelectorAll('[data-bracket-tab]')];
  const panels = [...root.querySelectorAll('[data-bracket-panel]')];
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const id = tab.getAttribute('data-bracket-tab');
      tabs.forEach((t) => {
        const on = t.getAttribute('data-bracket-tab') === id;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panels.forEach((p) => {
        p.hidden = p.getAttribute('data-bracket-panel') !== id;
      });
    });
  });
}
