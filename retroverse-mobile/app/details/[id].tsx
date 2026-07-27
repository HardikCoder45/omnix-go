import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, IconButton } from '@/components/Buttons';
import { GameCard } from '@/components/GameCard';
import { Scanlines } from '@/components/PixelDecor';
import { GAME_CATALOG, getGame } from '@/data/games';
import { useApp } from '@/state/AppProvider';
import { colors, radius, spacing, type } from '@/theme';

export default function GameDetails() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const game = getGame(id);
  const { favorites, toggleFavorite, highScores } = useApp();

  if (!game) {
    return (
      <View style={styles.missing}>
        <Ionicons name="warning-outline" size={36} color={colors.coral} />
        <Text style={styles.title}>TRANSMISSION LOST</Text>
        <Button onPress={() => router.back()} variant="secondary">GO BACK</Button>
      </View>
    );
  }

  const related = GAME_CATALOG.filter((item) => item.genre === game.genre && item.id !== game.id).slice(0, 4);
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
      <LinearGradient colors={[game.accent, game.accent2]} style={styles.art}>
        <Text style={styles.glyph}>{game.glyph}</Text>
        <View style={styles.artLabel}><Text style={styles.artLabelText}>RV-{game.id.slice(0, 4).toUpperCase()}</Text></View>
        <Scanlines />
      </LinearGradient>
      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.kicker}>{game.era} · {game.genre.toUpperCase()}</Text>
          <Text accessibilityRole="header" style={styles.title}>{game.title}</Text>
          <Text style={styles.tagline}>{game.tagline}</Text>
        </View>
        <IconButton label={favorites.includes(game.id) ? 'Remove from favorites' : 'Add to favorites'} icon={favorites.includes(game.id) ? 'heart' : 'heart-outline'} active={favorites.includes(game.id)} onPress={() => toggleFavorite(game.id)} />
      </View>
      <View style={styles.stats}>
        <Stat label="RATING" value={`★ ${game.rating}`} />
        <Stat label="PLAYERS" value={game.players} />
        <Stat label="HIGH SCORE" value={`${highScores[game.id] ?? 0}`} />
      </View>
      <Text style={styles.description}>{game.description}</Text>
      <View style={styles.tags}>{game.tags.map((tag) => <Text key={tag} style={styles.tag}>#{tag}</Text>)}</View>
      {game.playable ? (
        <Button onPress={() => router.push({ pathname: '/play/[id]', params: { id: game.id } })} icon="play" style={styles.play}>PLAY ORIGINAL</Button>
      ) : (
        <View style={styles.previewNotice}>
          <Ionicons name="radio-outline" color={colors.cyan} size={20} />
          <Text style={styles.previewText}>CATALOG PREVIEW · This fictional title is metadata-only in the prototype.</Text>
        </View>
      )}
      <Text style={styles.section}>MORE ON THIS FREQUENCY</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.related}>
        {related.map((item) => <GameCard key={item.id} game={item} compact />)}
      </ScrollView>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  content: { padding: spacing.md, paddingBottom: 80 },
  art: { height: 292, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  glyph: { color: colors.ink, fontFamily: type.display, fontSize: 130, fontWeight: '900' },
  artLabel: { position: 'absolute', left: spacing.md, bottom: spacing.md, borderWidth: 1, borderColor: colors.ink, paddingHorizontal: 8, paddingVertical: 4 },
  artLabelText: { color: colors.ink, fontFamily: type.display, fontWeight: '900', fontSize: 9 },
  headerRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', marginTop: spacing.lg },
  headerCopy: { flex: 1 },
  kicker: { color: colors.cyan, fontFamily: type.display, fontWeight: '900', fontSize: 10, letterSpacing: 1.4 },
  title: { color: colors.paper, fontFamily: type.display, fontSize: 30, fontWeight: '900', letterSpacing: -1, marginTop: 7 },
  tagline: { color: colors.muted, fontFamily: type.body, fontSize: 14, marginTop: 6 },
  stats: { flexDirection: 'row', borderTopWidth: 1, borderBottomWidth: 1, borderColor: colors.line, marginTop: spacing.lg, paddingVertical: spacing.md },
  stat: { flex: 1, alignItems: 'center', borderRightWidth: 1, borderColor: colors.line },
  statValue: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 16 },
  statLabel: { color: colors.muted, fontFamily: type.display, fontSize: 8, marginTop: 5 },
  description: { color: colors.paper, fontFamily: type.body, fontSize: 15, lineHeight: 23, marginTop: spacing.lg },
  tags: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  tag: { color: colors.lime, fontFamily: type.display, fontWeight: '800', fontSize: 10 },
  play: { marginTop: spacing.lg },
  previewNotice: { marginTop: spacing.lg, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.panel },
  previewText: { flex: 1, color: colors.muted, fontFamily: type.display, fontSize: 10, lineHeight: 15, fontWeight: '800' },
  section: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 15, marginTop: spacing.xl, marginBottom: spacing.md },
  related: { gap: spacing.md, paddingRight: spacing.md },
  missing: { flex: 1, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center', gap: spacing.lg, padding: spacing.xl },
});
