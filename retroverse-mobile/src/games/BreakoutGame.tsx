import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useApp } from '@/state/AppProvider';
import { colors, radius, spacing, type } from '@/theme';
import { Difficulty } from '@/types';
import { GameFrame } from './GameFrame';

const WORLD_W = 320;
const WORLD_H = 420;
const PADDLE_W = 72;
const PADDLE_Y = 386;
const BALL = 10;

type Ball = { x: number; y: number; vx: number; vy: number };
type Brick = { id: number; x: number; y: number; active: boolean };

function makeBricks(difficulty: Difficulty): Brick[] {
  const rows = difficulty === 'chill' ? 4 : difficulty === 'turbo' ? 7 : 5;
  return Array.from({ length: rows * 7 }, (_, id) => ({ id, x: 9 + (id % 7) * 44, y: 44 + Math.floor(id / 7) * 24, active: true }));
}

export function BreakoutGame({ gameId, title, accent = colors.coral, secondary = colors.amber, speed = 1, difficulty = 'normal' }: { gameId: string; title: string; accent?: string; secondary?: string; speed?: number; difficulty?: Difficulty }) {
  const { width } = useWindowDimensions();
  const boardWidth = Math.min(width - spacing.md * 2, 380);
  const scale = boardWidth / WORLD_W;
  const [ball, setBall] = useState<Ball>({ x: 155, y: 330, vx: 2.3 * speed, vy: -3.1 * speed });
  const [paddle, setPaddle] = useState((WORLD_W - PADDLE_W) / 2);
  const paddleRef = useRef(paddle);
  const [bricks, setBricks] = useState(() => makeBricks(difficulty));
  const bricksRef = useRef(bricks);
  const [score, setScore] = useState(0);
  const scoreRef = useRef(0);
  const [paused, setPaused] = useState(false);
  const [over, setOver] = useState(false);
  const { highScores, saveHighScore } = useApp();

  useEffect(() => { paddleRef.current = paddle; }, [paddle]);
  useEffect(() => { bricksRef.current = bricks; }, [bricks]);
  useEffect(() => { scoreRef.current = score; }, [score]);

  const restart = useCallback(() => {
    setBall({ x: 155, y: 330, vx: 2.3 * speed, vy: -3.1 * speed });
    setPaddle((WORLD_W - PADDLE_W) / 2);
    const nextBricks = makeBricks(difficulty);
    setBricks(nextBricks);
    bricksRef.current = nextBricks;
    setScore(0);
    scoreRef.current = 0;
    setPaused(false);
    setOver(false);
  }, [difficulty, speed]);

  useEffect(() => {
    if (paused || over) return;
    const timer = setInterval(() => {
      setBall((current) => {
        let next = { ...current, x: current.x + current.vx, y: current.y + current.vy };
        if (next.x <= 0 || next.x >= WORLD_W - BALL) next = { ...next, vx: -next.vx, x: Math.max(0, Math.min(WORLD_W - BALL, next.x)) };
        if (next.y <= 0) next = { ...next, vy: Math.abs(next.vy), y: 0 };
        if (next.y + BALL >= PADDLE_Y && next.y < PADDLE_Y + 14 && next.x + BALL >= paddleRef.current && next.x <= paddleRef.current + PADDLE_W && next.vy > 0) {
          const hit = ((next.x + BALL / 2) - paddleRef.current) / PADDLE_W - 0.5;
          next = { ...next, vy: -Math.abs(next.vy), vx: next.vx + hit * 1.6, y: PADDLE_Y - BALL };
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
        const hitBrick = bricksRef.current.find((brick) => brick.active && next.x + BALL >= brick.x && next.x <= brick.x + 39 && next.y + BALL >= brick.y && next.y <= brick.y + 16);
        if (hitBrick) {
          const updated = bricksRef.current.map((brick) => brick.id === hitBrick.id ? { ...brick, active: false } : brick);
          bricksRef.current = updated;
          setBricks(updated);
          next = { ...next, vy: -next.vy };
          const nextScore = scoreRef.current + 25;
          scoreRef.current = nextScore;
          setScore(nextScore);
          if (updated.every((brick) => !brick.active)) {
            setOver(true);
            saveHighScore(gameId, nextScore + 500);
            setScore(nextScore + 500);
          }
        }
        if (next.y > WORLD_H) {
          setOver(true);
          saveHighScore(gameId, scoreRef.current);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
        }
        return next;
      });
    }, 16);
    return () => clearInterval(timer);
  }, [gameId, over, paused, saveHighScore]);

  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => setPaddle(Math.max(0, Math.min(WORLD_W - PADDLE_W, event.nativeEvent.locationX / scale - PADDLE_W / 2))),
    onPanResponderMove: (event) => setPaddle(Math.max(0, Math.min(WORLD_W - PADDLE_W, event.nativeEvent.locationX / scale - PADDLE_W / 2))),
  }), [scale]);

  const nudge = (amount: number) => setPaddle((value) => Math.max(0, Math.min(WORLD_W - PADDLE_W, value + amount)));

  return (
    <GameFrame title={title} score={score} best={Math.max(highScores[gameId] ?? 0, score)} paused={paused} onPause={() => setPaused((value) => !value)} onRestart={restart} accent={accent}
      footer={<View style={styles.controls}><Pressable accessibilityRole="button" accessibilityLabel="Move paddle left" onPress={() => nudge(-34)} style={styles.control}><Text style={styles.arrow}>←</Text></Pressable><Text style={styles.hint}>DRAG THE BOARD{'\n'}OR TAP TO NUDGE</Text><Pressable accessibilityRole="button" accessibilityLabel="Move paddle right" onPress={() => nudge(34)} style={styles.control}><Text style={styles.arrow}>→</Text></Pressable></View>}
    >
      <View accessibilityLabel="Breakout game board" {...panResponder.panHandlers} style={[styles.board, { width: boardWidth, height: WORLD_H * scale }]}>
        {bricks.map((brick, index) => brick.active ? <View key={brick.id} style={[styles.brick, { left: brick.x * scale, top: brick.y * scale, width: 39 * scale, height: 16 * scale, backgroundColor: index % 2 ? accent : secondary }]} /> : null)}
        <View style={[styles.ball, { left: ball.x * scale, top: ball.y * scale, width: BALL * scale, height: BALL * scale }]} />
        <View style={[styles.paddle, { left: paddle * scale, top: PADDLE_Y * scale, width: PADDLE_W * scale, height: 12 * scale, backgroundColor: accent }]} />
        {over ? <Pressable accessibilityRole="button" accessibilityLabel="Game over, restart" onPress={restart} style={styles.over}><Text style={styles.overTitle}>{bricks.every((brick) => !brick.active) ? 'PRISM CLEARED' : 'CORE DROPPED'}</Text><Text style={styles.overBody}>Tap to launch again</Text></Pressable> : null}
      </View>
    </GameFrame>
  );
}

const styles = StyleSheet.create({
  board: { backgroundColor: '#0B0D14', borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, overflow: 'hidden' },
  brick: { position: 'absolute', borderRadius: 3 },
  ball: { position: 'absolute', borderRadius: 99, backgroundColor: colors.paper },
  paddle: { position: 'absolute', borderRadius: 5 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg },
  control: { width: 64, height: 52, borderRadius: radius.sm, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  arrow: { color: colors.paper, fontFamily: type.display, fontSize: 25, fontWeight: '900' },
  hint: { color: colors.muted, fontFamily: type.display, fontSize: 8, lineHeight: 12, fontWeight: '900', textAlign: 'center' },
  over: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(7,8,13,0.88)', alignItems: 'center', justifyContent: 'center' },
  overTitle: { color: colors.coral, fontFamily: type.display, fontSize: 23, fontWeight: '900' },
  overBody: { color: colors.paper, fontFamily: type.body, fontSize: 13, marginTop: 6 },
});
