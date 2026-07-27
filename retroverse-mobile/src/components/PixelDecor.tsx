import { StyleSheet, View } from 'react-native';
import { colors } from '@/theme';

export function Scanlines() {
  return (
    <View pointerEvents="none" style={styles.scanlines}>
      {Array.from({ length: 9 }, (_, index) => <View key={index} style={styles.line} />)}
    </View>
  );
}

export function PixelSpark({ color = colors.lime }: { color?: string }) {
  return (
    <View style={styles.spark}>
      <View style={[styles.sparkV, { backgroundColor: color }]} />
      <View style={[styles.sparkH, { backgroundColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  scanlines: {
    ...StyleSheet.absoluteFill,
    opacity: 0.14,
    justifyContent: 'space-around',
  },
  line: { height: StyleSheet.hairlineWidth, backgroundColor: colors.white },
  spark: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  sparkV: { position: 'absolute', width: 3, height: 20 },
  sparkH: { position: 'absolute', width: 20, height: 3 },
});
