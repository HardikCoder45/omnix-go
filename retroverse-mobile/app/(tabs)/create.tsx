import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '@/components/Buttons';
import { Scanlines } from '@/components/PixelDecor';
import { Screen } from '@/components/Screen';
import { useApp } from '@/state/AppProvider';
import { colors, radius, spacing, type } from '@/theme';
import { Creation, Difficulty, GameTemplate } from '@/types';

const templates: { id: GameTemplate; title: string; description: string; glyph: string }[] = [
  { id: 'snake', title: 'Grid Chaser', description: 'Collect, grow, survive', glyph: '〽' },
  { id: 'breakout', title: 'Brick Blaster', description: 'Bounce, aim, clear', glyph: '◇' },
  { id: 'memory', title: 'Pair Finder', description: 'Flip, recall, match', glyph: '✦' },
];
const palettes = [
  { name: 'Acid Pop', primary: '#C8FF45', secondary: '#51E8FF' },
  { name: 'Sunset Disk', primary: '#FF5C7C', secondary: '#FFC857' },
  { name: 'Dream Wave', primary: '#9A7BFF', secondary: '#51E8FF' },
  { name: 'Mono Heat', primary: '#F6F4EA', secondary: '#FF5C7C' },
];

export default function CreateScreen() {
  const { saveCreation } = useApp();
  const [template, setTemplate] = useState<GameTemplate>('snake');
  const [title, setTitle] = useState('My Neon Game');
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [speed, setSpeed] = useState(1);
  const [palette, setPalette] = useState(palettes[0]!);

  const preview = useMemo(() => templates.find((item) => item.id === template) ?? templates[0]!, [template]);

  const makeCreation = (): Creation => ({
    id: `created-${Date.now()}`,
    title: title.trim() || 'Untitled Transmission',
    template,
    difficulty,
    speed,
    primary: palette.primary,
    secondary: palette.secondary,
    createdAt: Date.now(),
  });

  const save = (launch: boolean) => {
    const creation = makeCreation();
    saveCreation(creation);
    if (launch) router.push({ pathname: '/play/[id]', params: { id: creation.id } });
    else Alert.alert('Game saved', `${creation.title} is now in your Library.`);
  };

  return (
    <Screen title="GAME LAB" eyebrow="NO CODE · ALL PLAY">
      <LinearGradient colors={[palette.primary, palette.secondary]} style={styles.preview}>
        <View style={styles.previewTop}><Text style={styles.previewLabel}>LIVE PREVIEW</Text><View style={styles.liveDot} /></View>
        <Text style={styles.previewGlyph}>{preview.glyph}</Text>
        <View>
          <Text numberOfLines={1} style={styles.previewTitle}>{title || 'UNTITLED'}</Text>
          <Text style={styles.previewMeta}>{preview.title.toUpperCase()} · {difficulty.toUpperCase()} · {speed.toFixed(1)}X</Text>
        </View>
        <Scanlines />
      </LinearGradient>

      <Step number="01" title="Choose a game loop">
        <View style={styles.templateGrid}>
          {templates.map((item) => (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityState={{ selected: template === item.id }}
              onPress={() => setTemplate(item.id)}
              style={[styles.template, template === item.id && { borderColor: palette.primary }]}
            >
              <Text style={[styles.templateGlyph, template === item.id && { color: palette.primary }]}>{item.glyph}</Text>
              <Text style={styles.templateTitle}>{item.title}</Text>
              <Text style={styles.templateBody}>{item.description}</Text>
              {template === item.id ? <Ionicons name="checkmark-circle" size={18} color={palette.primary} style={styles.check} /> : null}
            </Pressable>
          ))}
        </View>
      </Step>

      <Step number="02" title="Name your transmission">
        <TextInput
          accessibilityLabel="Game title"
          value={title}
          onChangeText={(value) => setTitle(value.slice(0, 28))}
          placeholder="Game title"
          placeholderTextColor={colors.muted}
          style={styles.input}
          maxLength={28}
        />
        <Text style={styles.counter}>{title.length}/28</Text>
      </Step>

      <Step number="03" title="Tune the rules">
        <Text style={styles.fieldLabel}>DIFFICULTY</Text>
        <View style={styles.options}>
          {(['chill', 'normal', 'turbo'] as Difficulty[]).map((item) => <Option key={item} label={item} active={difficulty === item} onPress={() => setDifficulty(item)} color={palette.primary} />)}
        </View>
        <Text style={styles.fieldLabel}>GAME SPEED</Text>
        <View style={styles.options}>
          {[0.8, 1, 1.25, 1.5].map((item) => <Option key={item} label={`${item}x`} active={speed === item} onPress={() => setSpeed(item)} color={palette.primary} />)}
        </View>
      </Step>

      <Step number="04" title="Paint the cabinet">
        <View style={styles.palettes}>
          {palettes.map((item) => (
            <Pressable key={item.name} accessibilityRole="button" accessibilityLabel={`Use ${item.name} palette`} accessibilityState={{ selected: palette.name === item.name }} onPress={() => setPalette(item)} style={[styles.palette, palette.name === item.name && styles.paletteActive]}>
              <View style={styles.swatches}><View style={[styles.swatch, { backgroundColor: item.primary }]} /><View style={[styles.swatch, { backgroundColor: item.secondary }]} /></View>
              <Text style={styles.paletteName}>{item.name}</Text>
            </Pressable>
          ))}
        </View>
      </Step>

      <View style={styles.actions}>
        <Button onPress={() => save(false)} variant="secondary" icon="save-outline" style={styles.action}>SAVE</Button>
        <Button onPress={() => save(true)} icon="play" style={styles.action}>SAVE & PLAY</Button>
      </View>
      <Text style={styles.footnote}>Creations are stored locally on this device. Sharing is represented as a prototype-ready configuration, with export/network delivery left for a future backend.</Text>
    </Screen>
  );
}

function Step({ number, title, children }: React.PropsWithChildren<{ number: string; title: string }>) {
  return <View style={styles.step}><View style={styles.stepHeader}><Text style={styles.stepNumber}>{number}</Text><Text style={styles.stepTitle}>{title}</Text></View>{children}</View>;
}

function Option({ label, active, onPress, color }: { label: string; active: boolean; onPress: () => void; color: string }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ selected: active }} onPress={onPress} style={[styles.option, active && { borderColor: color, backgroundColor: `${color}18` }]}><Text style={[styles.optionText, active && { color }]}>{label.toUpperCase()}</Text></Pressable>;
}

const styles = StyleSheet.create({
  preview: { height: 264, borderRadius: radius.lg, padding: spacing.lg, justifyContent: 'space-between', overflow: 'hidden' },
  previewTop: { flexDirection: 'row', justifyContent: 'space-between' },
  previewLabel: { color: colors.ink, fontFamily: type.display, fontWeight: '900', fontSize: 9, borderWidth: 1, borderColor: colors.ink, paddingHorizontal: 7, paddingVertical: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ink },
  previewGlyph: { position: 'absolute', right: 15, top: 30, color: 'rgba(7,8,13,0.22)', fontFamily: type.display, fontWeight: '900', fontSize: 150 },
  previewTitle: { color: colors.ink, fontFamily: type.display, fontWeight: '900', fontSize: 26, letterSpacing: -1 },
  previewMeta: { color: colors.ink, fontFamily: type.display, fontWeight: '900', fontSize: 9, marginTop: 5 },
  step: { marginTop: spacing.xl },
  stepHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  stepNumber: { color: colors.ink, backgroundColor: colors.cyan, fontFamily: type.display, fontSize: 9, fontWeight: '900', paddingHorizontal: 6, paddingVertical: 4 },
  stepTitle: { color: colors.paper, fontFamily: type.display, fontSize: 16, fontWeight: '900' },
  templateGrid: { flexDirection: 'row', gap: spacing.sm },
  template: { flex: 1, minHeight: 142, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, padding: spacing.sm, backgroundColor: colors.panel },
  templateGlyph: { color: colors.muted, fontFamily: type.display, fontSize: 29, fontWeight: '900' },
  templateTitle: { color: colors.paper, fontFamily: type.display, fontSize: 11, fontWeight: '900', marginTop: spacing.sm },
  templateBody: { color: colors.muted, fontFamily: type.body, fontSize: 9, lineHeight: 13, marginTop: 4 },
  check: { position: 'absolute', top: 8, right: 8 },
  input: { height: 54, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.panel, color: colors.paper, fontFamily: type.display, fontWeight: '800', paddingHorizontal: spacing.md, fontSize: 15 },
  counter: { color: colors.muted, fontFamily: type.display, fontSize: 9, textAlign: 'right', marginTop: 6 },
  fieldLabel: { color: colors.muted, fontFamily: type.display, fontSize: 9, fontWeight: '900', letterSpacing: 1.2, marginBottom: spacing.sm, marginTop: spacing.md },
  options: { flexDirection: 'row', gap: 8 },
  option: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel },
  optionText: { color: colors.muted, fontFamily: type.display, fontSize: 9, fontWeight: '900' },
  palettes: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  palette: { width: '48%', borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm, padding: spacing.sm, backgroundColor: colors.panel },
  paletteActive: { borderColor: colors.paper },
  swatches: { flexDirection: 'row', height: 28, borderRadius: 6, overflow: 'hidden' },
  swatch: { flex: 1 },
  paletteName: { color: colors.paper, fontFamily: type.display, fontSize: 10, fontWeight: '900', marginTop: 8 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  action: { flex: 1 },
  footnote: { color: colors.muted, fontFamily: type.body, fontSize: 10, lineHeight: 15, textAlign: 'center', marginTop: spacing.md },
});
