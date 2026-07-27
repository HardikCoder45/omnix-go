import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApp } from '@/state/AppProvider';
import { colors, radius, spacing, type } from '@/theme';
import { Difficulty } from '@/types';
import { GameFrame } from './GameFrame';

const symbols = ['✦', '◇', '☾', '♜', '≋', '⌘', '✿', '▲'];

function deckFor(difficulty: Difficulty) {
  const pairs = difficulty === 'chill' ? 4 : difficulty === 'turbo' ? 8 : 6;
  return symbols.slice(0, pairs).flatMap((symbol, index) => [{ id: index * 2, symbol, matched: false }, { id: index * 2 + 1, symbol, matched: false }]).sort(() => Math.random() - 0.5);
}

export function MemoryGame({ gameId, title, accent = colors.violet, secondary = colors.cyan, difficulty = 'normal' }: { gameId: string; title: string; accent?: string; secondary?: string; speed?: number; difficulty?: Difficulty }) {
  const [cards, setCards] = useState(() => deckFor(difficulty));
  const [flipped, setFlipped] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [paused, setPaused] = useState(false);
  const [locked, setLocked] = useState(false);
  const { highScores, saveHighScore } = useApp();
  const complete = cards.every((card) => card.matched);
  const score = complete ? Math.max(100, 1200 - moves * 35 - elapsed * 2) : Math.max(0, cards.filter((card) => card.matched).length * 100 - moves * 5);

  const restart = useCallback(() => {
    setCards(deckFor(difficulty));
    setFlipped([]);
    setMoves(0);
    setElapsed(0);
    setPaused(false);
    setLocked(false);
  }, [difficulty]);

  useEffect(() => {
    if (paused || complete) return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [complete, paused]);

  useEffect(() => {
    if (complete) {
      saveHighScore(gameId, score);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    }
  }, [complete, gameId, saveHighScore, score]);

  const choose = (id: number) => {
    if (paused || locked || flipped.includes(id) || cards.find((card) => card.id === id)?.matched) return;
    const next = [...flipped, id];
    setFlipped(next);
    Haptics.selectionAsync().catch(() => undefined);
    if (next.length === 2) {
      setMoves((value) => value + 1);
      setLocked(true);
      const [firstId, secondId] = next;
      const first = cards.find((card) => card.id === firstId);
      const second = cards.find((card) => card.id === secondId);
      if (first?.symbol === second?.symbol) {
        setTimeout(() => {
          setCards((current) => current.map((card) => card.id === firstId || card.id === secondId ? { ...card, matched: true } : card));
          setFlipped([]);
          setLocked(false);
        }, 320);
      } else {
        setTimeout(() => {
          setFlipped([]);
          setLocked(false);
        }, 700);
      }
    }
  };

  const columns = difficulty === 'turbo' ? 4 : difficulty === 'chill' ? 2 : 3;
  const rows = Math.ceil(cards.length / columns);
  const cardWidth = difficulty === 'chill' ? '45%' : difficulty === 'turbo' ? '22%' : '29%';
  const timeLabel = useMemo(() => `${Math.floor(elapsed / 60)}:${(elapsed % 60).toString().padStart(2, '0')}`, [elapsed]);

  return (
    <GameFrame title={title} score={score} best={Math.max(highScores[gameId] ?? 0, score)} paused={paused} onPause={() => setPaused((value) => !value)} onRestart={restart} accent={accent}
      footer={<View style={styles.footer}><View><Text style={styles.footerLabel}>MOVES</Text><Text style={styles.footerValue}>{moves}</Text></View><View><Text style={styles.footerLabel}>TIME</Text><Text style={styles.footerValue}>{timeLabel}</Text></View><View><Text style={styles.footerLabel}>PAIRS</Text><Text style={styles.footerValue}>{cards.filter((card) => card.matched).length / 2}/{cards.length / 2}</Text></View></View>}
    >
      <View accessibilityLabel="Memory match board" style={[styles.board, { maxWidth: 372, aspectRatio: columns / rows }]}>
        {cards.map((card) => {
          const visible = flipped.includes(card.id) || card.matched;
          return (
            <Pressable
              key={card.id}
              accessibilityRole="button"
              accessibilityLabel={card.matched ? `Matched ${card.symbol}` : visible ? `Card ${card.symbol}` : 'Hidden card'}
              disabled={card.matched}
              onPress={() => choose(card.id)}
              style={[styles.card, { width: cardWidth, borderColor: visible ? accent : colors.line, backgroundColor: visible ? accent : colors.panel }]}
            >
              <Text style={[styles.symbol, { color: visible ? colors.ink : secondary }]}>{visible ? card.symbol : '·'}</Text>
            </Pressable>
          );
        })}
        {complete ? <Pressable accessibilityRole="button" accessibilityLabel="Board cleared, play again" onPress={restart} style={styles.over}><Text style={styles.overTitle}>MEMORY SYNCED</Text><Text style={styles.overBody}>Score {score} · tap for a new deck</Text></Pressable> : null}
      </View>
    </GameFrame>
  );
}

const styles = StyleSheet.create({
  board: { width: '100%', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, justifyContent: 'center', alignContent: 'center', padding: spacing.sm, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: '#0B0D14' },
  card: { aspectRatio: 0.78, borderRadius: radius.sm, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  symbol: { fontFamily: type.display, fontSize: 28, fontWeight: '900' },
  footer: { flexDirection: 'row', justifyContent: 'space-around', borderTopWidth: 1, borderColor: colors.line, paddingTop: spacing.md },
  footerLabel: { color: colors.muted, fontFamily: type.display, fontSize: 8, fontWeight: '900', textAlign: 'center' },
  footerValue: { color: colors.paper, fontFamily: type.display, fontSize: 17, fontWeight: '900', textAlign: 'center', marginTop: 3 },
  over: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,8,13,0.9)', alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
  overTitle: { color: colors.violet, fontFamily: type.display, fontSize: 22, fontWeight: '900' },
  overBody: { color: colors.paper, fontFamily: type.body, fontSize: 12, marginTop: 7 },
});
