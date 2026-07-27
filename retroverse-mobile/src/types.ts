export type GameTemplate = 'snake' | 'breakout' | 'memory';
export type Difficulty = 'chill' | 'normal' | 'turbo';

export type Game = {
  id: string;
  title: string;
  tagline: string;
  description: string;
  genre: string;
  era: '80s' | '90s' | '00s';
  rating: number;
  players: string;
  accent: string;
  accent2: string;
  glyph: string;
  tags: string[];
  playable?: GameTemplate;
  featured?: boolean;
};

export type Creation = {
  id: string;
  title: string;
  template: GameTemplate;
  difficulty: Difficulty;
  speed: number;
  primary: string;
  secondary: string;
  createdAt: number;
};

export type RecentPlay = {
  id: string;
  playedAt: number;
};

export type PlayerStats = {
  sessions: number;
  totalScore: number;
  gamesCreated: number;
};
