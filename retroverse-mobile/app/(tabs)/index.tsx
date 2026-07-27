import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Link, router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Buttons';
import { GameCard } from '@/components/GameCard';
import { Scanlines } from '@/components/PixelDecor';
import { Screen } from '@/components/Screen';
import { SectionHeader } from '@/components/SectionHeader';
import { GAME_CATALOG, getGame } from '@/data/games';
import { useApp } from '@/state/AppProvider';
import { colors, radius, shadow, spacing, type } from '@/theme';

const categories = [
  { name: 'Arcade', glyph: '✦', color: colors.coral },
  { name: 'Puzzle', glyph: '◇', color: colors.cyan },
  { name: 'Racing', glyph: '≈', color: colors.amber },
  { name: 'Cozy', glyph: '✿', color: colors.lime },
  { name: 'Mystery', glyph: '≋', color: colors.violet },
];

export default function HomeScreen() {
  const { recent, highScores } = useApp();
  const continueGames = recent.map((item) => getGame(item.id)).filter((game) => Boolean(game));
  const trending = GAME_CATALOG.filter((game) => game.rating >= 4.8).slice(0, 7);

  return (
    <Screen title="RETROVERSE" eyebrow="PLAYER ONE · ONLINE" right={<View style={styles.live}><View style={styles.dot} /><Text style={styles.liveText}>LIVE</Text></View>}>
      <LinearGradient colors={['#FF5C7C', '#9A7BFF', '#51E8FF']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
        <View style={styles.heroBadge}><Text style={styles.heroBadgeText}>FEATURED DROP / 01</Text></View>
        <Text style={styles.heroGlyph}>〽</Text>
        <Text style={styles.heroTitle}>NEON{'\n'}NIBBLER</Text>
        <Text style={styles.heroSub}>A grid classic re-tuned for touch.</Text>
        <View style={styles.heroActions}>
          <Button onPress={() => router.push('/play/snake')} icon="play">PLAY NOW</Button>
          <Link href="/details/snake" asChild>
            <Pressable accessibilityRole="button" accessibilityLabel="View Neon Nibbler details" style={styles.roundButton}>
              <Ionicons name="information" color={colors.paper} size={20} />
            </Pressable>
          </Link>
        </View>
        <Scanlines />
      </LinearGradient>

      <View style={styles.ticker}>
        <Text style={styles.tickerLabel}>NOW TRENDING</Text>
        <Text numberOfLines={1} style={styles.tickerText}>DREAM KART 199X  ✦  GHOST FREQUENCY  ✦  CASSETTE QUEST</Text>
      </View>

      <SectionHeader title="Continue playing" action="ARCADE" onPress={() => router.push('/arcade')} />
      {continueGames.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {continueGames.map((game) => game ? (
            <Link key={game.id} href={{ pathname: '/play/[id]', params: { id: game.id } }} asChild>
              <Pressable style={styles.continueCard}>
                <LinearGradient colors={[game.accent, game.accent2]} style={styles.continueArt}>
                  <Text style={styles.continueGlyph}>{game.glyph}</Text>
                </LinearGradient>
                <View style={styles.continueCopy}>
                  <Text style={styles.continueTitle}>{game.title}</Text>
                  <Text style={styles.score}>BEST {highScores[game.id] ?? 0}</Text>
                  <View style={styles.progress}><View style={[styles.progressFill, { width: '62%', backgroundColor: game.accent }]} /></View>
                </View>
                <Ionicons name="play-circle" size={32} color={colors.paper} />
              </Pressable>
            </Link>
          ) : null)}
        </ScrollView>
      ) : null}

      <SectionHeader title="Trending transmissions" action="VIEW ALL" onPress={() => router.push('/discover')} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {trending.map((game) => <GameCard key={game.id} game={game} />)}
      </ScrollView>

      <SectionHeader title="Pick a frequency" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {categories.map((category) => (
          <Pressable
            key={category.name}
            accessibilityRole="button"
            accessibilityLabel={`Browse ${category.name} games`}
            onPress={() => router.push({ pathname: '/discover', params: { genre: category.name } })}
            style={[styles.category, { borderColor: category.color }]}
          >
            <Text style={[styles.categoryGlyph, { color: category.color }]}>{category.glyph}</Text>
            <Text style={styles.categoryTitle}>{category.name}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <SectionHeader title="Daily challenge" />
      <View style={styles.challenge}>
        <View>
          <Text style={styles.challengeKicker}>DAY 227 · 2X XP</Text>
          <Text style={styles.challengeTitle}>Signal sprint</Text>
          <Text style={styles.challengeBody}>Score 120 in Neon Nibbler.{'\n'}One run. No continues.</Text>
        </View>
        <View style={styles.challengeRight}>
          <Text style={styles.challengeTime}>11:42:08</Text>
          <Button onPress={() => router.push('/play/snake')} variant="secondary">ACCEPT</Button>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  live: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 9, paddingVertical: 6, borderRadius: radius.pill },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.lime },
  liveText: { color: colors.paper, fontFamily: type.display, fontSize: 9, fontWeight: '900' },
  hero: { minHeight: 372, borderRadius: radius.lg, padding: spacing.lg, overflow: 'hidden', justifyContent: 'flex-end', ...shadow },
  heroBadge: { position: 'absolute', top: spacing.md, left: spacing.md, borderWidth: 1, borderColor: colors.ink, paddingHorizontal: 9, paddingVertical: 5 },
  heroBadgeText: { color: colors.ink, fontFamily: type.display, fontSize: 9, fontWeight: '900' },
  heroGlyph: { position: 'absolute', right: -20, top: 18, color: 'rgba(7,8,13,0.18)', fontFamily: type.display, fontSize: 210, fontWeight: '900', transform: [{ rotate: '-8deg' }] },
  heroTitle: { color: colors.ink, fontFamily: type.display, fontSize: 48, lineHeight: 43, fontWeight: '900', letterSpacing: -3 },
  heroSub: { color: colors.ink, fontFamily: type.body, fontSize: 14, fontWeight: '700', marginTop: spacing.sm },
  heroActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  roundButton: { width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(7,8,13,0.72)', alignItems: 'center', justifyContent: 'center' },
  ticker: { marginTop: spacing.md, borderWidth: 1, borderColor: colors.line, padding: spacing.sm, flexDirection: 'row', gap: spacing.sm, overflow: 'hidden' },
  tickerLabel: { color: colors.ink, backgroundColor: colors.lime, fontFamily: type.display, fontWeight: '900', fontSize: 9, paddingHorizontal: 6, paddingVertical: 2 },
  tickerText: { flex: 1, color: colors.muted, fontFamily: type.display, fontSize: 9, paddingVertical: 2 },
  row: { gap: spacing.md, paddingRight: spacing.md },
  continueCard: { width: 300, padding: spacing.sm, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  continueArt: { width: 64, height: 64, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  continueGlyph: { color: colors.ink, fontFamily: type.display, fontSize: 32, fontWeight: '900' },
  continueCopy: { flex: 1 },
  continueTitle: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 13 },
  score: { color: colors.muted, fontFamily: type.display, fontSize: 9, marginTop: 4 },
  progress: { height: 3, backgroundColor: colors.line, marginTop: 10 },
  progressFill: { height: 3 },
  category: { width: 118, height: 112, backgroundColor: colors.panel, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, justifyContent: 'space-between' },
  categoryGlyph: { fontFamily: type.display, fontSize: 32, fontWeight: '900' },
  categoryTitle: { color: colors.paper, fontFamily: type.display, fontSize: 12, fontWeight: '900' },
  challenge: { borderRadius: radius.md, borderWidth: 1, borderColor: colors.coral, backgroundColor: '#1A1119', padding: spacing.lg, flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  challengeKicker: { color: colors.coral, fontFamily: type.display, fontSize: 9, fontWeight: '900', letterSpacing: 1.2 },
  challengeTitle: { color: colors.paper, fontFamily: type.display, fontSize: 20, fontWeight: '900', marginTop: 8 },
  challengeBody: { color: colors.muted, fontFamily: type.body, fontSize: 12, lineHeight: 18, marginTop: 7 },
  challengeRight: { alignItems: 'flex-end', justifyContent: 'space-between' },
  challengeTime: { color: colors.amber, fontFamily: type.display, fontSize: 12, fontWeight: '900' },
});
