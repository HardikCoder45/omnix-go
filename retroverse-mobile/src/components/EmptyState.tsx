import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, type } from '@/theme';

export function EmptyState({ icon = 'planet-outline', title, body }: { icon?: keyof typeof Ionicons.glyphMap; title: string; body: string }) {
  return (
    <View style={styles.root}>
      <Ionicons name={icon} size={30} color={colors.cyan} />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    padding: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    borderStyle: 'dashed',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.panel,
  },
  title: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 16 },
  body: { color: colors.muted, fontFamily: type.body, fontSize: 13, lineHeight: 19, textAlign: 'center' },
});
