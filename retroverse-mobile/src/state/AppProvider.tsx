import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import React, { createContext, PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Creation, PlayerStats, RecentPlay } from '@/types';

const STORAGE_KEY = '@retroverse/state/v1';

type PersistedState = {
  favorites: string[];
  recent: RecentPlay[];
  highScores: Record<string, number>;
  creations: Creation[];
  stats: PlayerStats;
};

type AppContextValue = PersistedState & {
  hydrated: boolean;
  toggleFavorite: (id: string) => void;
  recordPlay: (id: string) => void;
  saveHighScore: (id: string, score: number) => void;
  saveCreation: (creation: Creation) => void;
  deleteCreation: (id: string) => void;
};

const initialState: PersistedState = {
  favorites: ['snake', 'cassette-quest', 'ghost-frequency'],
  recent: [{ id: 'snake', playedAt: Date.now() - 1000 * 60 * 18 }],
  highScores: {},
  creations: [],
  stats: { sessions: 0, totalScore: 0, gamesCreated: 0 },
};

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PersistedState>(initialState);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (active && raw) setState({ ...initialState, ...(JSON.parse(raw) as PersistedState) });
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (hydrated) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => undefined);
  }, [hydrated, state]);

  const toggleFavorite = useCallback((id: string) => {
    Haptics.selectionAsync().catch(() => undefined);
    setState((current) => ({
      ...current,
      favorites: current.favorites.includes(id)
        ? current.favorites.filter((gameId) => gameId !== id)
        : [id, ...current.favorites],
    }));
  }, []);

  const recordPlay = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      recent: [{ id, playedAt: Date.now() }, ...current.recent.filter((item) => item.id !== id)].slice(0, 12),
      stats: { ...current.stats, sessions: current.stats.sessions + 1 },
    }));
  }, []);

  const saveHighScore = useCallback((id: string, score: number) => {
    setState((current) => {
      const previous = current.highScores[id] ?? 0;
      if (score <= previous) return current;
      return {
        ...current,
        highScores: { ...current.highScores, [id]: score },
        stats: { ...current.stats, totalScore: current.stats.totalScore + (score - previous) },
      };
    });
  }, []);

  const saveCreation = useCallback((creation: Creation) => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setState((current) => ({
      ...current,
      creations: [creation, ...current.creations.filter((item) => item.id !== creation.id)],
      stats: { ...current.stats, gamesCreated: current.stats.gamesCreated + 1 },
    }));
  }, []);

  const deleteCreation = useCallback((id: string) => {
    setState((current) => ({
      ...current,
      creations: current.creations.filter((item) => item.id !== id),
      favorites: current.favorites.filter((item) => item !== id),
      recent: current.recent.filter((item) => item.id !== id),
    }));
  }, []);

  const value = useMemo(
    () => ({ ...state, hydrated, toggleFavorite, recordPlay, saveHighScore, saveCreation, deleteCreation }),
    [state, hydrated, toggleFavorite, recordPlay, saveHighScore, saveCreation, deleteCreation],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside AppProvider');
  return value;
}
