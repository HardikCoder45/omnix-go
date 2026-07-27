import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Button } from '@/components/Buttons';
import { Scanlines } from '@/components/PixelDecor';
import { Screen } from '@/components/Screen';
import { PLAYABLE_GAMES } from '@/data/games';
import { useApp } from '@/state/AppProvider';
import { colors, radius, shadow, spacing, type } from '@/theme';

const gameNotes = {
  snake: 'ONE-THUMB GRID CHASE',
  breakout: 'PHOTON PADDLE ACTION',
  memory: 'TACTILE PAIR SPRINT',
};

export default function ArcadeScreen() {
  const { highScores } = useApp();
  return (
    <Screen title="ARCADE" eyebrow="3 LOCAL GAMES · NO WIFI NEEDED">
      <View style={styles.marquee}>
        <View style={styles.bulb} /><Text style={styles.marqueeText}>INSERT IMAGINATION</Text><View style={styles.bulb} />
      </View>
      {PLAYABLE_GAMES.map((game, index) => (
        <Pressable
          key={game.id}
          accessibilityRole="button"
          accessibilityLabel={`Play ${game.title}`}
          onPress={() => router.push({ pathname: '/play/[id]', params: { id: game.id } })}
          style={({ pressed }) => [styles.machine, pressed && styles.pressed]}
        >
          <LinearGradient colors={[game.accent, game.accent2]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.art}>
            <Text style={styles.number}>0{index + 1}</Text>
            <Text style={styles.glyph}>{game.glyph}</Text>
            <Scanlines />
          </LinearGradient>
          <View style={styles.copy}>
            <Text style={styles.note}>{gameNotes[game.id as keyof typeof gameNotes]}</Text>
            <Text style={styles.title}>{game.title}</Text>
            <Text style={styles.tagline}>{game.tagline}</Text>
            <View style={styles.bottom}>
              <View><Text style={styles.bestLabel}>YOUR BEST</Text><Text style={styles.best}>{highScores[game.id] ?? 0}</Text></View>
              <Button onPress={() => router.push({ pathname: '/play/[id]', params: { id: game.id } })} icon="play">PLAY</Button>
            </View>
          </View>
        </Pressable>
      ))}
      <View style={styles.offline}>
        <Text style={styles.offlineGlyph}>⌁</Text>
        <View style={styles.offlineCopy}>
          <Text style={styles.offlineTitle}>BUILT FOR THE DEAD ZONE</Text>
          <Text style={styles.offlineBody}>Every arcade title runs entirely on-device. Scores and progress stay with you.</Text>
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  marquee: { height: 44, borderWidth: 1, borderColor: colors.amber, backgroundColor: '#1B160C', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.md, marginBottom: spacing.lg },
  bulb: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.amber },
  marqueeText: { color: colors.amber, fontFamily: type.display, fontSize: 12, fontWeight: '900', letterSpacing: 1.8 },
  machine: { backgroundColor: colors.panel, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.line, marginBottom: spacing.lg, ...shadow },
  pressed: { opacity: 0.8, transform: [{ scale: 0.99 }] },
  art: { height: 210, alignItems: 'center', justifyContent: 'center' },
  number: { position: 'absolute', left: spacing.md, top: spacing.md, color: colors.ink, fontFamily: type.display, fontSize: 13, fontWeight: '900' },
  glyph: { color: colors.ink, fontFamily: type.display, fontSize: 100, fontWeight: '900' },
  copy: { padding: spacing.lg },
  note: { color: colors.cyan, fontFamily: type.display, fontSize: 9, fontWeight: '900', letterSpacing: 1.5 },
  title: { color: colors.paper, fontFamily: type.display, fontSize: 23, fontWeight: '900', marginTop: 6 },
  tagline: { color: colors.muted, fontFamily: type.body, fontSize: 13, marginTop: 5 },
  bottom: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: spacing.lg },
  bestLabel: { color: colors.muted, fontFamily: type.display, fontSize: 8, fontWeight: '900' },
  best: { color: colors.paper, fontFamily: type.display, fontSize: 22, fontWeight: '900', marginTop: 2 },
  offline: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: spacing.lg, gap: spacing.md, backgroundColor: colors.panel },
  offlineGlyph: { color: colors.lime, fontFamily: type.display, fontSize: 36, fontWeight: '900' },
  offlineCopy: { flex: 1 },
  offlineTitle: { color: colors.paper, fontFamily: type.display, fontSize: 12, fontWeight: '900' },
  offlineBody: { color: colors.muted, fontFamily: type.body, fontSize: 12, lineHeight: 18, marginTop: 5 },
});
