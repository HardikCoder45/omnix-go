import { useEffect } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { BreakoutGame } from '@/games/BreakoutGame';
import { MemoryGame } from '@/games/MemoryGame';
import { SnakeGame } from '@/games/SnakeGame';
import { getGame } from '@/data/games';
import { useApp } from '@/state/AppProvider';
import { colors, spacing, type } from '@/theme';
import { GameTemplate } from '@/types';

export default function PlayScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { creations, recordPlay } = useApp();
  const creation = creations.find((item) => item.id === id);
  const catalog = getGame(id);
  const template = creation?.template ?? catalog?.playable;

  useEffect(() => {
    if (template) recordPlay(id);
  }, [id, recordPlay, template]);

  if (!template) {
    return <View style={styles.missing}><Text style={styles.missingTitle}>GAME FILE NOT FOUND</Text><Text style={styles.missingBody}>This transmission cannot be launched.</Text></View>;
  }

  const props = {
    gameId: id,
    title: creation?.title ?? catalog?.title ?? 'Untitled Game',
    accent: creation?.primary ?? catalog?.accent,
    secondary: creation?.secondary ?? catalog?.accent2,
    speed: creation?.speed ?? 1,
    difficulty: creation?.difficulty ?? 'normal',
  };

  return <Game template={template} props={props} />;
}

function Game({ template, props }: { template: GameTemplate; props: React.ComponentProps<typeof SnakeGame> }) {
  if (template === 'breakout') return <BreakoutGame {...props} />;
  if (template === 'memory') return <MemoryGame {...props} />;
  return <SnakeGame {...props} />;
}

const styles = StyleSheet.create({
  missing: { flex: 1, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  missingTitle: { color: colors.coral, fontFamily: type.display, fontSize: 20, fontWeight: '900' },
  missingBody: { color: colors.muted, fontFamily: type.body, fontSize: 13, marginTop: spacing.sm },
});
