export function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickByeIndex(songs, byeCounts) {
  let bestIdx = songs.length - 1;
  let bestCount = Infinity;
  for (let i = songs.length - 1; i >= 0; i--) {
    const c = byeCounts.get(songs[i].id) || 0;
    if (c < bestCount) {
      bestCount = c;
      bestIdx = i;
    }
  }
  return bestIdx;
}

export function buildRound(songs, byeCounts = new Map()) {
  const list = [...songs];
  let bye = null;

  if (list.length % 2 === 1 && list.length > 0) {
    const idx = pickByeIndex(list, byeCounts);
    bye = list.splice(idx, 1)[0];
  }

  const matches = [];
  for (let i = 0; i + 1 < list.length; i += 2) {
    matches.push({
      id: `${list[i].id}-vs-${list[i + 1].id}-${i}`,
      a: list[i],
      b: list[i + 1],
    });
  }
  return { matches, bye };
}

function noteBye(byeCounts, bye) {
  if (!bye) return byeCounts;
  const next = new Map(byeCounts);
  next.set(bye.id, (next.get(bye.id) || 0) + 1);
  return next;
}

export function roundLabel(remainingCount, initialCount = null) {
  const n = Math.max(0, Number(remainingCount) || 0);
  if (n === 2) return 'Final';
  if (n === 4) return 'Semifinals';
  if (n === 8) return 'Quarterfinals';
  if (n === 16) return 'Round of 16';
  if (n === 32) return 'Round of 32';
  if (n === 64) return 'Round of 64';
  // Non-power-of-two fields: label by total songs still alive (whole tournament)
  if (initialCount != null && n === initialCount) {
    return `${initialCount} songs`;
  }
  return `${n} songs left`;
}

export function splitRegions(songs) {
  const mid = Math.ceil(songs.length / 2);
  return {
    left: songs.slice(0, mid),
    right: songs.slice(mid),
  };
}

function buildRegionState(songs, region, byeCounts) {
  if (songs.length === 0) {
    return {
      region,
      songs: [],
      matches: [],
      bye: null,
      winners: [],
      champion: null,
    };
  }
  if (songs.length === 1) {
    return {
      region,
      songs: [...songs],
      matches: [],
      bye: null,
      winners: [],
      champion: songs[0],
    };
  }
  const { matches, bye } = buildRound(songs, byeCounts);
  return {
    region,
    songs: [...songs],
    matches: matches.map((m) => ({ ...m, region })),
    bye,
    winners: [],
    champion: null,
  };
}

function resolveDualByes(left, right, byeCounts) {
  let nextLeft = { ...left };
  let nextRight = { ...right };
  let nextByeCounts = byeCounts;
  let crossMatch = null;

  if (nextLeft.bye && nextRight.bye) {
    crossMatch = {
      id: `cross-${nextLeft.bye.id}-vs-${nextRight.bye.id}`,
      a: nextLeft.bye,
      b: nextRight.bye,
      region: 'cross',
    };
    nextLeft = { ...nextLeft, bye: null };
    nextRight = { ...nextRight, bye: null };
  } else {
    nextByeCounts = noteBye(nextByeCounts, nextLeft.bye);
    nextByeCounts = noteBye(nextByeCounts, nextRight.bye);
  }

  return {
    left: nextLeft,
    right: nextRight,
    byeCounts: nextByeCounts,
    crossMatch,
  };
}

function flattenMatches(left, right, finalMatch, crossMatch) {
  if (finalMatch) return [finalMatch];
  const list = [...(left.matches || []), ...(right.matches || [])];
  if (crossMatch) list.push(crossMatch);
  return list;
}

function regionFromAdvancers(region, advancers, byeCounts) {
  if (advancers.length <= 1) {
    return {
      region,
      songs: advancers,
      matches: [],
      bye: null,
      winners: [],
      champion: advancers[0] || null,
      byeCounts,
    };
  }
  const built = buildRound(advancers, byeCounts);
  return {
    region,
    songs: advancers,
    matches: built.matches.map((m) => ({ ...m, region })),
    bye: built.bye,
    winners: [],
    champion: null,
    byeCounts,
  };
}

function collectAdvancers(regionState) {
  if (regionState.champion) return [regionState.champion];
  if (regionState.bye) return [...(regionState.winners || []), regionState.bye];
  return [...(regionState.winners || [])];
}

export function createTournament(playlist, tracks, seeding) {
  const list = Array.isArray(tracks) ? tracks.filter((t) => t && t.id) : [];
  if (list.length < 2) {
    throw new Error('Need at least 2 playable songs in the playlist to run a tournament.');
  }
  const ordered = seeding === 'shuffle' ? shuffle(list) : [...list];
  const { left: leftSongs, right: rightSongs } = splitRegions(ordered);

  let byeCounts = new Map();
  let left = buildRegionState(leftSongs, 'left', byeCounts);
  let right = buildRegionState(rightSongs, 'right', byeCounts);

  const resolved = resolveDualByes(left, right, byeCounts);
  left = resolved.left;
  right = resolved.right;
  byeCounts = resolved.byeCounts;
  const crossMatch = resolved.crossMatch;

  if (left.champion && !rightSongs.length) {
    return finishedState(playlist, ordered, left, right, byeCounts, left.champion, seeding);
  }
  if (right.champion && !leftSongs.length) {
    return finishedState(playlist, ordered, left, right, byeCounts, right.champion, seeding);
  }

  let finalMatch = null;
  if (left.champion && right.champion) {
    finalMatch = {
      id: `final-${left.champion.id}-vs-${right.champion.id}`,
      a: left.champion,
      b: right.champion,
      region: 'final',
    };
  }

  return {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      image: playlist.image,
      spotifyUrl: playlist.spotifyUrl,
      owner: playlist.owner,
    },
    seeding,
    initialCount: ordered.length,
    history: [],
    byeCounts,
    left,
    right,
    finalMatch,
    crossMatch,
    crossWinner: null,
    matches: flattenMatches(left, right, finalMatch, crossMatch),
    matchIndex: 0,
    roundNumber: 1,
    remaining: ordered.length,
    bye: left.bye || right.bye,
    winners: [],
    champion: null,
    finished: false,
  };
}

function finishedState(playlist, ordered, left, right, byeCounts, champion, seeding = 'order') {
  return {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      image: playlist.image,
      spotifyUrl: playlist.spotifyUrl,
      owner: playlist.owner,
    },
    seeding,
    initialCount: ordered.length,
    history: [],
    byeCounts,
    left,
    right,
    finalMatch: null,
    crossMatch: null,
    crossWinner: null,
    matches: [],
    matchIndex: 0,
    roundNumber: 1,
    remaining: 1,
    bye: null,
    winners: [],
    champion,
    finished: true,
  };
}

function advanceRegions(state) {
  let byeCounts = new Map(state.byeCounts || []);

  let leftList = collectAdvancers(state.left);
  let rightList = collectAdvancers(state.right);

  if (state.crossWinner) {
    if (leftList.length <= rightList.length) {
      leftList = [...leftList, state.crossWinner];
    } else {
      rightList = [...rightList, state.crossWinner];
    }
  }

  const leftBuilt = regionFromAdvancers('left', leftList, byeCounts);
  byeCounts = leftBuilt.byeCounts || byeCounts;
  let left = {
    region: 'left',
    songs: leftBuilt.songs,
    matches: leftBuilt.matches,
    bye: leftBuilt.bye,
    winners: [],
    champion: leftBuilt.champion,
  };

  const rightBuilt = regionFromAdvancers('right', rightList, byeCounts);
  byeCounts = rightBuilt.byeCounts || byeCounts;
  let right = {
    region: 'right',
    songs: rightBuilt.songs,
    matches: rightBuilt.matches,
    bye: rightBuilt.bye,
    winners: [],
    champion: rightBuilt.champion,
  };

  if (left.champion && right.champion) {
    const finalMatch = {
      id: `final-${left.champion.id}-vs-${right.champion.id}`,
      a: left.champion,
      b: right.champion,
      region: 'final',
    };
    return {
      ...state,
      left,
      right,
      byeCounts,
      finalMatch,
      crossMatch: null,
      crossWinner: null,
      matches: [finalMatch],
      matchIndex: 0,
      roundNumber: state.roundNumber + 1,
      remaining: Math.max(2, state.initialCount - state.history.length),
      bye: null,
      winners: [],
    };
  }

  if (left.champion && right.songs.length === 0) {
    return {
      ...state,
      left,
      right,
      byeCounts,
      finalMatch: null,
      crossMatch: null,
      crossWinner: null,
      matches: [],
      matchIndex: 0,
      champion: left.champion,
      finished: true,
      remaining: 1,
      bye: null,
      winners: [],
    };
  }
  if (right.champion && left.songs.length === 0) {
    return {
      ...state,
      left,
      right,
      byeCounts,
      finalMatch: null,
      crossMatch: null,
      crossWinner: null,
      matches: [],
      matchIndex: 0,
      champion: right.champion,
      finished: true,
      remaining: 1,
      bye: null,
      winners: [],
    };
  }

  const resolved = resolveDualByes(left, right, byeCounts);
  left = resolved.left;
  right = resolved.right;
  byeCounts = resolved.byeCounts;

  if (left.champion && right.champion) {
    const finalMatch = {
      id: `final-${left.champion.id}-vs-${right.champion.id}`,
      a: left.champion,
      b: right.champion,
      region: 'final',
    };
    return {
      ...state,
      left,
      right,
      byeCounts,
      finalMatch,
      crossMatch: null,
      crossWinner: null,
      matches: [finalMatch],
      matchIndex: 0,
      roundNumber: state.roundNumber + 1,
      remaining: Math.max(2, state.initialCount - state.history.length),
      bye: null,
      winners: [],
    };
  }

  return {
    ...state,
    left,
    right,
    byeCounts,
    finalMatch: null,
    crossMatch: resolved.crossMatch,
    crossWinner: null,
    matches: flattenMatches(left, right, null, resolved.crossMatch),
    matchIndex: 0,
    roundNumber: state.roundNumber + 1,
    remaining: Math.max(2, state.initialCount - state.history.length),
    bye: left.bye || right.bye,
    winners: [],
  };
}

export function pickWinner(state, side) {
  if (!state || state.finished) return state;
  if (!Array.isArray(state.matches) || state.matchIndex >= state.matches.length) {
    return state;
  }
  if (side !== 'a' && side !== 'b') return state;

  const match = state.matches[state.matchIndex];
  if (!match?.a?.id || !match?.b?.id) return state;

  const winner = side === 'a' ? match.a : match.b;
  const loser = side === 'a' ? match.b : match.a;
  const region = match.region || 'left';

  let left = {
    ...state.left,
    winners: [...(state.left?.winners || [])],
  };
  let right = {
    ...state.right,
    winners: [...(state.right?.winners || [])],
  };
  let crossWinner = state.crossWinner || null;

  if (region === 'left') {
    left.winners = [...left.winners, winner];
  } else if (region === 'right') {
    right.winners = [...right.winners, winner];
  } else if (region === 'cross') {
    crossWinner = winner;
  }

  const history = [
    ...(state.history || []),
    {
      round: state.roundNumber,
      matchIndex: state.matchIndex,
      region,
      a: match.a,
      b: match.b,
      winnerId: winner.id,
      loserId: loser.id,
    },
  ];

  const next = {
    ...state,
    left,
    right,
    crossWinner,
    history,
    matchIndex: state.matchIndex + 1,
    // Songs still alive = field size minus one elimination per completed match
    remaining: Math.max(1, (state.initialCount || history.length + 1) - history.length),
  };

  if (region === 'final') {
    return {
      ...next,
      champion: winner,
      finished: true,
      matches: [],
      finalMatch: null,
      crossMatch: null,
      crossWinner: null,
      remaining: 1,
      bye: null,
      winners: [],
    };
  }

  if (next.matchIndex < next.matches.length) {
    return next;
  }

  return advanceRegions(next);
}

export function currentMatch(state) {
  if (!state || state.finished) return null;
  if (!Array.isArray(state.matches) || state.matchIndex >= state.matches.length) {
    return null;
  }
  const match = state.matches[state.matchIndex];
  if (!match?.a?.id || !match?.b?.id) return null;
  return match;
}

export function progress(state) {
  const totalMatchesThisWave = Array.isArray(state?.matches) ? state.matches.length : 0;
  const doneThisWave = state?.matchIndex || 0;
  const totalSongs = state?.initialCount || 0;
  const approxTotalMatches = Math.max(1, totalSongs - 1);
  const completedHistory = Array.isArray(state?.history) ? state.history.length : 0;

  const match = currentMatch(state);
  const region = match?.region;

  // Always label from total songs left in the whole tournament (not one half)
  let label = 'Final';
  if (region === 'final' || state?.remaining === 2) {
    label = 'Final';
  } else {
    label = roundLabel(state?.remaining, state?.initialCount);
  }

  return {
    roundNumber: state?.roundNumber || 1,
    roundLabel: label,
    remaining: state?.remaining ?? totalSongs,
    matchInRound: totalMatchesThisWave ? doneThisWave + 1 : 0,
    matchesInRound: totalMatchesThisWave,
    completedMatches: completedHistory,
    approxTotalMatches,
    hasBye: false,
    byeSong: null,
    byes: [],
    region: region || null,
  };
}
