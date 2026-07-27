import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Buttons';
import { EmptyState } from '@/components/EmptyState';
import { GameCard } from '@/components/GameCard';
import { Screen } from '@/components/Screen';
import { getGame } from '@/data/games';
import { useApp } from '@/state/AppProvider';
import { colors, radius, spacing, type } from '@/theme';
import { Creation } from '@/types';

const achievements = [
  { title: 'FIRST QUARTER', note: 'Play 25 sessions', icon: 'radio', threshold: 25 },
  { title: 'HIGH VOLTAGE', note: 'Bank 1,000 score', icon: 'flash', threshold: 1000 },
  { title: 'GAME MAKER', note: 'Create 3 games', icon: 'construct', threshold: 3 },
];

export default function LibraryScreen() {
  const { favorites, recent, creations, highScores, stats, deleteCreation } = useApp();
  const favoriteGames = favorites.map(getGame).filter((game) => Boolean(game));
  const recentGames = recent.map((item) => getGame(item.id)).filter((game) => Boolean(game)).slice(0, 6);
  const topScore = Math.max(0, ...Object.values(highScores));

  const confirmDelete = (creation: Creation) => {
    Alert.alert('Delete creation?', `${creation.title} will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteCreation(creation.id) },
    ]);
  };

  return (
    <Screen title="LIBRARY" eyebrow="LOCAL PLAYER ARCHIVE">
      <LinearGradient colors={['#171A25', '#22263A']} style={styles.profile}>
        <LinearGradient colors={[colors.coral, colors.violet]} style={styles.avatar}><Text style={styles.avatarText}>PX</Text></LinearGradient>
        <View style={styles.profileCopy}>
          <Text style={styles.handle}>PIXEL_EXPLORER</Text>
          <Text style={styles.level}>LEVEL 08 · SIGNAL SCOUT</Text>
          <View style={styles.xp}><View style={styles.xpFill} /></View>
          <Text style={styles.xpText}>1,840 / 2,400 XP</Text>
        </View>
        <Ionicons name="settings-outline" size={21} color={colors.muted} />
      </LinearGradient>

      <View style={styles.stats}>
        <Stat value={stats.sessions} label="SESSIONS" />
        <Stat value={topScore} label="TOP SCORE" />
        <Stat value={creations.length} label="CREATED" />
        <Stat value={favorites.length} label="SAVED" />
      </View>

      <Heading title="Your creations" action="NEW GAME" onPress={() => router.push('/create')} />
      {creations.length ? (
        <View style={styles.creationList}>
          {creations.map((creation) => (
            <View key={creation.id} style={styles.creation}>
              <LinearGradient colors={[creation.primary, creation.secondary]} style={styles.creationArt}>
                <Text style={styles.creationGlyph}>{creation.template === 'snake' ? '〽' : creation.template === 'breakout' ? '◇' : '✦'}</Text>
              </LinearGradient>
              <View style={styles.creationCopy}>
                <Text numberOfLines={1} style={styles.creationTitle}>{creation.title}</Text>
                <Text style={styles.creationMeta}>{creation.template.toUpperCase()} · {creation.difficulty.toUpperCase()} · {creation.speed}X</Text>
                <View style={styles.creationActions}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Play ${creation.title}`} onPress={() => router.push({ pathname: '/play/[id]', params: { id: creation.id } })}><Ionicons name="play-circle" size={30} color={creation.primary} /></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Share ${creation.title} configuration`} onPress={() => Share.share({ message: `I made “${creation.title}” in Retroverse — a ${creation.difficulty} ${creation.template} game at ${creation.speed}x speed.` }).catch(() => undefined)}><Ionicons name="share-outline" size={21} color={colors.paper} /></Pressable>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Delete ${creation.title}`} onPress={() => confirmDelete(creation)}><Ionicons name="trash-outline" size={20} color={colors.coral} /></Pressable>
                </View>
              </View>
            </View>
          ))}
        </View>
      ) : <EmptyState icon="construct-outline" title="Your cabinet is empty" body="Build a game in the Game Lab and it will appear here, ready to play." />}

      <Heading title="Favorites" action="DISCOVER" onPress={() => router.push('/discover')} />
      {favoriteGames.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
          {favoriteGames.map((game) => game ? <GameCard key={game.id} game={game} compact /> : null)}
        </ScrollView>
      ) : <EmptyState icon="heart-outline" title="No favorites yet" body="Tap the heart on any catalog game to save it here." />}

      <Heading title="Recently played" />
      {recentGames.length ? (
        <View style={styles.recentList}>
          {recentGames.map((game, index) => game ? (
            <Pressable key={game.id} onPress={() => game.playable ? router.push({ pathname: '/play/[id]', params: { id: game.id } }) : router.push({ pathname: '/details/[id]', params: { id: game.id } })} style={styles.recent}>
              <Text style={styles.recentNumber}>{String(index + 1).padStart(2, '0')}</Text>
              <View style={[styles.recentGlyph, { backgroundColor: game.accent }]}><Text style={styles.recentGlyphText}>{game.glyph}</Text></View>
              <View style={styles.recentCopy}><Text style={styles.recentTitle}>{game.title}</Text><Text style={styles.recentMeta}>{game.genre} · BEST {highScores[game.id] ?? 0}</Text></View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </Pressable>
          ) : null)}
        </View>
      ) : null}

      <Heading title="Achievements" />
      <View style={styles.achievements}>
        {achievements.map((achievement, index) => {
          const value = index === 0 ? stats.sessions : index === 1 ? stats.totalScore : stats.gamesCreated;
          const unlocked = value >= achievement.threshold;
          return (
            <View key={achievement.title} style={[styles.achievement, !unlocked && styles.locked]}>
              <View style={[styles.medal, unlocked && styles.medalUnlocked]}><Ionicons name={achievement.icon as keyof typeof Ionicons.glyphMap} size={21} color={unlocked ? colors.ink : colors.muted} /></View>
              <Text style={styles.achievementTitle}>{achievement.title}</Text>
              <Text style={styles.achievementNote}>{unlocked ? 'UNLOCKED' : achievement.note}</Text>
            </View>
          );
        })}
      </View>
      <Button variant="ghost" icon="download-outline" onPress={() => Alert.alert('Local-first profile', 'Cloud backup is not connected in this prototype.')}>BACKUP PROFILE</Button>
    </Screen>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return <View style={styles.stat}><Text style={styles.statValue}>{value}</Text><Text style={styles.statLabel}>{label}</Text></View>;
}

function Heading({ title, action, onPress }: { title: string; action?: string; onPress?: () => void }) {
  return <View style={styles.heading}><Text style={styles.headingTitle}>{title}</Text>{action ? <Pressable onPress={onPress}><Text style={styles.headingAction}>{action} ↗</Text></Pressable> : null}</View>;
}

const styles = StyleSheet.create({
  profile: { minHeight: 128, borderRadius: radius.lg, padding: spacing.lg, flexDirection: 'row', alignItems: 'center', gap: spacing.md, borderWidth: 1, borderColor: colors.line },
  avatar: { width: 66, height: 66, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.ink, fontFamily: type.display, fontSize: 22, fontWeight: '900' },
  profileCopy: { flex: 1 },
  handle: { color: colors.paper, fontFamily: type.display, fontSize: 15, fontWeight: '900' },
  level: { color: colors.cyan, fontFamily: type.display, fontSize: 8, fontWeight: '900', marginTop: 5 },
  xp: { height: 4, backgroundColor: colors.line, marginTop: 13 },
  xpFill: { height: 4, width: '76%', backgroundColor: colors.lime },
  xpText: { color: colors.muted, fontFamily: type.display, fontSize: 7, marginTop: 4 },
  stats: { flexDirection: 'row', marginTop: spacing.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: 'hidden' },
  stat: { flex: 1, paddingVertical: spacing.md, alignItems: 'center', backgroundColor: colors.panel, borderRightWidth: 1, borderColor: colors.line },
  statValue: { color: colors.paper, fontFamily: type.display, fontSize: 17, fontWeight: '900' },
  statLabel: { color: colors.muted, fontFamily: type.display, fontSize: 7, marginTop: 4 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl, marginBottom: spacing.md },
  headingTitle: { color: colors.paper, fontFamily: type.display, fontSize: 18, fontWeight: '900' },
  headingAction: { color: colors.cyan, fontFamily: type.display, fontSize: 9, fontWeight: '900' },
  creationList: { gap: spacing.sm },
  creation: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.panel },
  creationArt: { width: 104, alignItems: 'center', justifyContent: 'center' },
  creationGlyph: { color: colors.ink, fontFamily: type.display, fontSize: 43, fontWeight: '900' },
  creationCopy: { flex: 1, padding: spacing.md },
  creationTitle: { color: colors.paper, fontFamily: type.display, fontSize: 14, fontWeight: '900' },
  creationMeta: { color: colors.muted, fontFamily: type.display, fontSize: 8, marginTop: 5 },
  creationActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.md },
  row: { gap: spacing.md, paddingRight: spacing.md },
  recentList: { borderTopWidth: 1, borderColor: colors.line },
  recent: { minHeight: 70, borderBottomWidth: 1, borderColor: colors.line, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  recentNumber: { color: colors.muted, fontFamily: type.display, fontSize: 9 },
  recentGlyph: { width: 42, height: 42, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  recentGlyphText: { color: colors.ink, fontFamily: type.display, fontSize: 20, fontWeight: '900' },
  recentCopy: { flex: 1 },
  recentTitle: { color: colors.paper, fontFamily: type.display, fontSize: 12, fontWeight: '900' },
  recentMeta: { color: colors.muted, fontFamily: type.display, fontSize: 8, marginTop: 5 },
  achievements: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xl },
  achievement: { flex: 1, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.panel, alignItems: 'center', padding: spacing.sm, minHeight: 130 },
  locked: { opacity: 0.46 },
  medal: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.panelSoft, alignItems: 'center', justifyContent: 'center' },
  medalUnlocked: { backgroundColor: colors.amber },
  achievementTitle: { color: colors.paper, fontFamily: type.display, fontSize: 8, lineHeight: 11, fontWeight: '900', textAlign: 'center', marginTop: spacing.sm },
  achievementNote: { color: colors.muted, fontFamily: type.body, fontSize: 8, lineHeight: 11, textAlign: 'center', marginTop: 4 },
});
