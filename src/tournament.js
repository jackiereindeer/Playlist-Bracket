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

export function roundLabel(remainingCount) {
  if (remainingCount === 2) return 'Final';
  if (remainingCount === 4) return 'Semifinals';
  if (remainingCount === 8) return 'Quarterfinals';
  return `${remainingCount} remaining`;
}

export function regionRoundLabel(songCount) {
  if (songCount <= 1) return 'Waiting';
  if (songCount === 2) return 'Semifinal';
  if (songCount === 4) return 'Quarterfinal';
  if (songCount === 8) return 'Round of 8';
  return `${songCount} remaining`;
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

function flattenMatches(left, right, finalMatch) {
  if (finalMatch) return [finalMatch];
  return [...(left.matches || []), ...(right.matches || [])];
}

function totalRemaining(left, right, finalMatch) {
  if (finalMatch) return 2;
  const l = left.champion ? 1 : left.songs?.length || 0;
  const r = right.champion ? 1 : right.songs?.length || 0;
  return l + r;
}

export function createTournament(playlist, tracks, seeding) {
  const ordered = seeding === 'shuffle' ? shuffle(tracks) : [...tracks];
  const { left: leftSongs, right: rightSongs } = splitRegions(ordered);

  let byeCounts = new Map();
  const left = buildRegionState(leftSongs, 'left', byeCounts);
  byeCounts = noteBye(byeCounts, left.bye);
  const right = buildRegionState(rightSongs, 'right', byeCounts);
  byeCounts = noteBye(byeCounts, right.bye);

  if (left.champion && !rightSongs.length) {
    return finishedState(playlist, ordered, left, right, byeCounts, left.champion);
  }
  if (right.champion && !leftSongs.length) {
    return finishedState(playlist, ordered, left, right, byeCounts, right.champion);
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

  const matches = flattenMatches(left, right, finalMatch);

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

    matches,
    matchIndex: 0,
    roundNumber: 1,
    remaining: totalRemaining(left, right, finalMatch),

    bye: left.bye || right.bye,
    winners: [],
    champion: null,
    finished: false,
  };
}

function finishedState(playlist, ordered, left, right, byeCounts, champion) {
  return {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      image: playlist.image,
      spotifyUrl: playlist.spotifyUrl,
      owner: playlist.owner,
    },
    seeding: 'order',
    initialCount: ordered.length,
    history: [],
    byeCounts,
    left,
    right,
    finalMatch: null,
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
  let left = { ...state.left };
  let right = { ...state.right };

  if (!left.champion) {
    const leftAdvancers = left.bye
      ? [...left.winners, left.bye]
      : [...left.winners];
    if (leftAdvancers.length <= 1) {
      left = {
        ...left,
        songs: leftAdvancers,
        matches: [],
        bye: null,
        winners: [],
        champion: leftAdvancers[0] || null,
      };
    } else {
      const built = buildRound(leftAdvancers, byeCounts);
      byeCounts = noteBye(byeCounts, built.bye);
      left = {
        region: 'left',
        songs: leftAdvancers,
        matches: built.matches.map((m) => ({ ...m, region: 'left' })),
        bye: built.bye,
        winners: [],
        champion: null,
      };
    }
  }

  if (!right.champion) {
    const rightAdvancers = right.bye
      ? [...right.winners, right.bye]
      : [...right.winners];
    if (rightAdvancers.length <= 1) {
      right = {
        ...right,
        songs: rightAdvancers,
        matches: [],
        bye: null,
        winners: [],
        champion: rightAdvancers[0] || null,
      };
    } else {
      const built = buildRound(rightAdvancers, byeCounts);
      byeCounts = noteBye(byeCounts, built.bye);
      right = {
        region: 'right',
        songs: rightAdvancers,
        matches: built.matches.map((m) => ({ ...m, region: 'right' })),
        bye: built.bye,
        winners: [],
        champion: null,
      };
    }
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

  if (left.champion && !right.champion && right.songs?.length === 0) {
    return {
      ...state,
      left,
      right,
      byeCounts,
      finalMatch: null,
      matches: [],
      matchIndex: 0,
      champion: left.champion,
      finished: true,
      remaining: 1,
      bye: null,
      winners: [],
    };
  }
  if (right.champion && !left.champion && left.songs?.length === 0) {
    return {
      ...state,
      left,
      right,
      byeCounts,
      finalMatch: null,
      matches: [],
      matchIndex: 0,
      champion: right.champion,
      finished: true,
      remaining: 1,
      bye: null,
      winners: [],
    };
  }

  const matches = flattenMatches(left, right, finalMatch);

  return {
    ...state,
    left,
    right,
    byeCounts,
    finalMatch,
    matches,
    matchIndex: 0,
    roundNumber: state.roundNumber + 1,
    remaining: totalRemaining(left, right, finalMatch),
    bye: left.bye || right.bye,
    winners: [],
  };
}

export function pickWinner(state, side) {
  if (state.finished || state.matchIndex >= state.matches.length) return state;

  const match = state.matches[state.matchIndex];
  const winner = side === 'a' ? match.a : match.b;
  const loser = side === 'a' ? match.b : match.a;
  const region = match.region || 'left';

  let left = { ...state.left, winners: [...(state.left.winners || [])] };
  let right = { ...state.right, winners: [...(state.right.winners || [])] };

  if (region === 'left') {
    left.winners = [...left.winners, winner];
  } else if (region === 'right') {
    right.winners = [...right.winners, winner];
  }

  const next = {
    ...state,
    left,
    right,
    history: [
      ...state.history,
      {
        round: state.roundNumber,
        matchIndex: state.matchIndex,
        region,
        a: match.a,
        b: match.b,
        winnerId: winner.id,
        loserId: loser.id,
      },
    ],
    matchIndex: state.matchIndex + 1,
  };

  if (region === 'final') {
    return {
      ...next,
      champion: winner,
      finished: true,
      matches: [],
      finalMatch: null,
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
  if (state.finished || state.matchIndex >= state.matches.length) return null;
  return state.matches[state.matchIndex];
}

export function progress(state) {
  const totalMatchesThisWave = state.matches.length;
  const doneThisWave = state.matchIndex;
  const totalSongs = state.initialCount;
  const approxTotalMatches = Math.max(1, totalSongs - 1);
  const completedHistory = state.history.length;

  const match = currentMatch(state);
  const region = match?.region;

  const byes = [];
  if (state.left?.bye) byes.push({ region: 'left', song: state.left.bye });
  if (state.right?.bye) byes.push({ region: 'right', song: state.right.bye });

  let label = roundLabel(state.remaining);
  if (region === 'final') {
    label = 'Final';
  } else if (region === 'left') {
    label = regionRoundLabel(state.left.songs?.length || 0);
  } else if (region === 'right') {
    label = regionRoundLabel(state.right.songs?.length || 0);
  }

  return {
    roundNumber: state.roundNumber,
    roundLabel: label,
    remaining: state.remaining,
    matchInRound: totalMatchesThisWave ? doneThisWave + 1 : 0,
    matchesInRound: totalMatchesThisWave,
    completedMatches: completedHistory,
    approxTotalMatches,
    hasBye: byes.length > 0,
    byeSong: byes[0]?.song || null,
    byes,
    region: region || null,
  };
}
