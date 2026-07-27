import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '@/theme';

type Props = { title: string; action?: string; onPress?: () => void };

export function SectionHeader({ title, action, onPress }: Props) {
  return (
    <View style={styles.row}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      {action ? (
        <Pressable accessibilityRole="button" accessibilityLabel={action} hitSlop={10} onPress={onPress}>
          <Text style={styles.action}>{action} ↗</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  title: { color: colors.paper, fontFamily: type.display, fontSize: 18, fontWeight: '900' },
  action: { color: colors.cyan, fontFamily: type.display, fontSize: 11, fontWeight: '800', letterSpacing: 0.7 },
});
