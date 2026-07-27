import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useApp } from '@/state/AppProvider';
import { colors, radius, spacing, type } from '@/theme';
import { Difficulty } from '@/types';
import { GameFrame } from './GameFrame';

type Point = { x: number; y: number };
type Direction = 'up' | 'down' | 'left' | 'right';

const COLS = 16;
const ROWS = 20;
const starts: Point[] = [{ x: 7, y: 10 }, { x: 6, y: 10 }, { x: 5, y: 10 }];
const deltas: Record<Direction, Point> = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
const opposite: Record<Direction, Direction> = { up: 'down', down: 'up', left: 'right', right: 'left' };

function makeFood(snake: Point[]): Point {
  const free: Point[] = [];
  for (let y = 0; y < ROWS; y += 1) for (let x = 0; x < COLS; x += 1) if (!snake.some((part) => part.x === x && part.y === y)) free.push({ x, y });
  return free[Math.floor(Math.random() * free.length)] ?? { x: 2, y: 2 };
}

export function SnakeGame({ gameId, title, accent = colors.lime, secondary = colors.cyan, speed = 1, difficulty = 'normal' }: { gameId: string; title: string; accent?: string; secondary?: string; speed?: number; difficulty?: Difficulty }) {
  const { width } = useWindowDimensions();
  const boardWidth = Math.min(width - spacing.md * 2, 380);
  const cell = Math.floor(boardWidth / COLS);
  const [snake, setSnake] = useState(starts);
  const [food, setFood] = useState<Point>(() => makeFood(starts));
  const [direction, setDirectionState] = useState<Direction>('right');
  const directionRef = useRef<Direction>('right');
  const [score, setScore] = useState(0);
  const [paused, setPaused] = useState(false);
  const [over, setOver] = useState(false);
  const { highScores, saveHighScore } = useApp();
  const tick = Math.max(70, (difficulty === 'chill' ? 180 : difficulty === 'turbo' ? 95 : 135) / speed);

  const restart = useCallback(() => {
    setSnake(starts);
    setFood(makeFood(starts));
    directionRef.current = 'right';
    setDirectionState('right');
    setScore(0);
    setPaused(false);
    setOver(false);
  }, []);

  const setDirection = useCallback((next: Direction) => {
    if (opposite[directionRef.current] === next) return;
    directionRef.current = next;
    setDirectionState(next);
    if (over) restart();
  }, [over, restart]);

  useEffect(() => {
    if (paused || over) return;
    const timer = setInterval(() => {
      setSnake((current) => {
        const delta = deltas[directionRef.current];
        const head = current[0] ?? starts[0]!;
        const next = { x: head.x + delta.x, y: head.y + delta.y };
        const hitWall = next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS;
        const hitSelf = current.some((part) => part.x === next.x && part.y === next.y);
        if (hitWall || hitSelf) {
          setOver(true);
          saveHighScore(gameId, score);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
          return current;
        }
        const ate = next.x === food.x && next.y === food.y;
        const updated = ate ? [next, ...current] : [next, ...current.slice(0, -1)];
        if (ate) {
          setScore((value) => value + 10);
          setFood(makeFood(updated));
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        return updated;
      });
    }, tick);
    return () => clearInterval(timer);
  }, [food, gameId, over, paused, saveHighScore, score, tick]);

  return (
    <GameFrame title={title} score={score} best={Math.max(highScores[gameId] ?? 0, score)} paused={paused} onPause={() => setPaused((value) => !value)} onRestart={restart} accent={accent}
      footer={<DirectionPad direction={direction} onDirection={setDirection} accent={accent} />}
    >
      <View accessibilityLabel="Snake game board" style={[styles.board, { width: cell * COLS, height: cell * ROWS }]}>
        {Array.from({ length: COLS * ROWS }, (_, index) => <View key={index} style={[styles.gridCell, { width: cell, height: cell }]} />)}
        {snake.map((part, index) => <View key={`${part.x}-${part.y}-${index}`} style={[styles.snake, { left: part.x * cell + 2, top: part.y * cell + 2, width: cell - 4, height: cell - 4, backgroundColor: index === 0 ? secondary : accent }]} />)}
        <View style={[styles.food, { left: food.x * cell + 4, top: food.y * cell + 4, width: cell - 8, height: cell - 8, backgroundColor: colors.coral }]} />
        {over ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Game over, restart" onPress={restart} style={styles.over}>
            <Text style={styles.overTitle}>SIGNAL LOST</Text>
            <Text style={styles.overBody}>Tap to reboot</Text>
          </Pressable>
        ) : null}
      </View>
    </GameFrame>
  );
}

function DirectionPad({ direction, onDirection, accent }: { direction: Direction; onDirection: (direction: Direction) => void; accent: string }) {
  return (
    <View style={styles.dpad}>
      {(['left', 'up', 'down', 'right'] as Direction[]).map((item) => (
        <Pressable key={item} accessibilityRole="button" accessibilityLabel={`Move ${item}`} onPress={() => onDirection(item)} style={[styles.dkey, direction === item && { borderColor: accent }]}>
          <Text style={[styles.arrow, direction === item && { color: accent }]}>{item === 'left' ? '←' : item === 'right' ? '→' : item === 'up' ? '↑' : '↓'}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  board: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: '#0C0F15', borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  gridCell: { borderRightWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.035)' },
  snake: { position: 'absolute', borderRadius: 3 },
  food: { position: 'absolute', borderRadius: 99 },
  over: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,8,13,0.88)', alignItems: 'center', justifyContent: 'center' },
  overTitle: { color: colors.coral, fontFamily: type.display, fontSize: 25, fontWeight: '900' },
  overBody: { color: colors.paper, fontFamily: type.body, fontSize: 13, marginTop: 6 },
  dpad: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  dkey: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  arrow: { color: colors.paper, fontFamily: type.display, fontSize: 25, fontWeight: '900' },
});
