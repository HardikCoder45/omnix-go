import { Ionicons } from '@expo/vector-icons';
import { PropsWithChildren, ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors, radius, spacing, type } from '@/theme';

type Props = PropsWithChildren<{
  title: string;
  score: number;
  best: number;
  paused: boolean;
  onPause: () => void;
  onRestart: () => void;
  accent: string;
  footer?: ReactNode;
}>;

export function GameFrame({ title, score, best, paused, onPause, onRestart, accent, children, footer }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + spacing.sm, paddingBottom: insets.bottom + spacing.sm }]}>
      <View style={styles.topbar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close game" onPress={() => router.back()} style={styles.icon}>
          <Ionicons name="close" color={colors.paper} size={23} />
        </Pressable>
        <View style={styles.titleWrap}>
          <Text style={styles.kicker}>RETROVERSE ARCADE</Text>
          <Text numberOfLines={1} style={styles.title}>{title}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel={paused ? 'Resume game' : 'Pause game'} onPress={onPause} style={styles.icon}>
          <Ionicons name={paused ? 'play' : 'pause'} color={accent} size={22} />
        </Pressable>
      </View>
      <View style={styles.scorebar}>
        <View><Text style={styles.scoreLabel}>SCORE</Text><Text style={[styles.score, { color: accent }]}>{score.toString().padStart(4, '0')}</Text></View>
        <View style={styles.best}><Text style={styles.scoreLabel}>PERSONAL BEST</Text><Text style={styles.bestValue}>{best.toString().padStart(4, '0')}</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Restart game" onPress={onRestart} style={styles.restart}>
          <Ionicons name="refresh" size={18} color={colors.paper} />
        </Pressable>
      </View>
      <View style={styles.gameArea}>
        {children}
        {paused ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Resume game" onPress={onPause} style={styles.pauseOverlay}>
            <Ionicons name="pause-circle" color={accent} size={54} />
            <Text style={styles.pauseTitle}>PAUSED</Text>
            <Text style={styles.pauseBody}>Tap anywhere to resume</Text>
          </Pressable>
        ) : null}
      </View>
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink, paddingHorizontal: spacing.md },
  topbar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  titleWrap: { flex: 1, alignItems: 'center' },
  kicker: { color: colors.muted, fontFamily: type.display, fontWeight: '900', fontSize: 8, letterSpacing: 1.3 },
  title: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 15, marginTop: 3 },
  scorebar: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md, padding: spacing.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.panel },
  scoreLabel: { color: colors.muted, fontFamily: type.display, fontWeight: '900', fontSize: 8, letterSpacing: 1 },
  score: { fontFamily: type.display, fontWeight: '900', fontSize: 23, marginTop: 2 },
  best: { flex: 1, marginLeft: spacing.xl },
  bestValue: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 17, marginTop: 3 },
  restart: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.panelSoft, alignItems: 'center', justifyContent: 'center' },
  gameArea: { flex: 1, marginTop: spacing.md, alignItems: 'center', justifyContent: 'center' },
  pauseOverlay: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,8,13,0.9)', alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, zIndex: 5 },
  pauseTitle: { color: colors.paper, fontFamily: type.display, fontSize: 26, fontWeight: '900', marginTop: spacing.sm },
  pauseBody: { color: colors.muted, fontFamily: type.body, fontSize: 13, marginTop: 5 },
  footer: { minHeight: 100, justifyContent: 'center' },
});
