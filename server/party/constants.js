/** Party mode constants — no accounts; identity is name + color + avatar. */

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I
export const CODE_LENGTH = 6;

export const COLORS = [
  { id: 'red', hex: '#ef4444', label: 'Red' },
  { id: 'orange', hex: '#f97316', label: 'Orange' },
  { id: 'amber', hex: '#f59e0b', label: 'Amber' },
  { id: 'green', hex: '#22c55e', label: 'Green' },
  { id: 'teal', hex: '#14b8a6', label: 'Teal' },
  { id: 'blue', hex: '#3b82f6', label: 'Blue' },
  { id: 'indigo', hex: '#6366f1', label: 'Indigo' },
  { id: 'purple', hex: '#a855f7', label: 'Purple' },
  { id: 'pink', hex: '#ec4899', label: 'Pink' },
  { id: 'slate', hex: '#94a3b8', label: 'Slate' },
];

/** Funny preset avatars (emoji). No custom uploads in v1. */
export const AVATARS = [
  { id: 'frog', emoji: '🐸', label: 'Frog' },
  { id: 'fox', emoji: '🦊', label: 'Fox' },
  { id: 'cat', emoji: '🐱', label: 'Cat' },
  { id: 'dog', emoji: '🐶', label: 'Dog' },
  { id: 'owl', emoji: '🦉', label: 'Owl' },
  { id: 'alien', emoji: '👽', label: 'Alien' },
  { id: 'robot', emoji: '🤖', label: 'Robot' },
  { id: 'ghost', emoji: '👻', label: 'Ghost' },
  { id: 'fire', emoji: '🔥', label: 'Fire' },
  { id: 'moon', emoji: '🌙', label: 'Moon' },
  { id: 'pizza', emoji: '🍕', label: 'Pizza' },
  { id: 'skull', emoji: '💀', label: 'Skull' },
];

/** Starts only after the host casts their vote (both Sync and Desync). */
export const DEFAULT_VOTE_SECONDS = 30;
/** If host never votes, resolve with a random match winner. */
export const HOST_BACKUP_SECONDS = 300;
export const IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_NAME_LEN = 24;
export const MAX_PLAYERS = 32;
/** Group Rate allows a larger room (design lock). */
export const MAX_PLAYERS_GROUP_RATE = 100;

export const PHASE = {
  LOBBY: 'lobby',
  MATCH: 'match',
  REVEAL: 'reveal',
  TIE_BREAK: 'tie_break',
  WINNER: 'winner',
  CHAMPION: 'champion',
  /** Group Rate: everyone rates the current song */
  RATE_SONG: 'rate_song',
  /** Group Rate: short reveal of scores + average before next song (like bracket winner beat) */
  RATE_REVEAL: 'rate_reveal',
  /** Group Rate: ranked results until everyone hits Continue */
  RATE_RESULTS: 'rate_results',
};

export const GAME_MODE = {
  BRACKET: 'bracket',
  GROUP_RATE: 'group_rate',
};
