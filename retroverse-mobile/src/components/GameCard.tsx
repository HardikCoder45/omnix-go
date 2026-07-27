import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Link } from 'expo-router';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Game } from '@/types';
import { colors, radius, shadow, spacing, type } from '@/theme';
import { useApp } from '@/state/AppProvider';
import { Scanlines } from './PixelDecor';

type Props = { game: Game; wide?: boolean; compact?: boolean };

export const GameCard = memo(function GameCard({ game, wide, compact }: Props) {
  const { favorites, toggleFavorite } = useApp();
  const liked = favorites.includes(game.id);
  return (
    <Link href={{ pathname: '/details/[id]', params: { id: game.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${game.title}`}
        style={({ pressed }) => [styles.card, wide && styles.wide, compact && styles.compact, pressed && styles.pressed]}
      >
        <LinearGradient colors={[game.accent, game.accent2]} style={styles.art}>
          <Text style={styles.glyph}>{game.glyph}</Text>
          <Text style={styles.era}>{game.era}</Text>
          <Scanlines />
        </LinearGradient>
        <View style={styles.copy}>
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={styles.title}>{game.title}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={liked ? `Remove ${game.title} from favorites` : `Add ${game.title} to favorites`}
              onPress={(event) => {
                event.stopPropagation();
                toggleFavorite(game.id);
              }}
              hitSlop={8}
            >
              <Ionicons name={liked ? 'heart' : 'heart-outline'} size={18} color={liked ? colors.coral : colors.muted} />
            </Pressable>
          </View>
          <Text numberOfLines={1} style={styles.meta}>{game.genre} · ★ {game.rating}</Text>
          {!compact ? <Text numberOfLines={2} style={styles.tagline}>{game.tagline}</Text> : null}
        </View>
      </Pressable>
    </Link>
  );
});

const styles = StyleSheet.create({
  card: {
    width: 188,
    backgroundColor: colors.panel,
    borderRadius: radius.md,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.line,
    ...shadow,
  },
  wide: { width: 240 },
  compact: { width: 154 },
  pressed: { opacity: 0.78, transform: [{ scale: 0.985 }] },
  art: {
    height: 126,
    padding: spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  glyph: { color: colors.ink, fontFamily: type.display, fontSize: 60, fontWeight: '900' },
  era: {
    position: 'absolute',
    top: 10,
    right: 10,
    color: colors.ink,
    fontFamily: type.display,
    fontSize: 10,
    fontWeight: '900',
    borderWidth: 1,
    borderColor: colors.ink,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  copy: { padding: spacing.md, minHeight: 112 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 15 },
  meta: { color: colors.cyan, fontFamily: type.display, fontSize: 10, fontWeight: '700', marginTop: 5 },
  tagline: { color: colors.muted, fontFamily: type.body, fontSize: 12, lineHeight: 17, marginTop: 9 },
});
