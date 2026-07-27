import { PropsWithChildren, ReactNode } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from '@/theme';

type Props = PropsWithChildren<{
  title?: string;
  eyebrow?: string;
  right?: ReactNode;
  scroll?: boolean;
}>;

export function Screen({ children, title, eyebrow, right, scroll = true }: Props) {
  const header = title ? (
    <View style={styles.header}>
      <View style={styles.headerCopy}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      </View>
      {right}
    </View>
  ) : null;

  if (!scroll) {
    return (
      <View style={styles.root}>
        {header}
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      {header}
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  content: { paddingHorizontal: spacing.md, paddingBottom: 132 },
  header: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  headerCopy: { flex: 1 },
  eyebrow: {
    color: colors.lime,
    fontFamily: type.display,
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 2.2,
    marginBottom: 5,
  },
  title: {
    color: colors.paper,
    fontFamily: type.display,
    fontWeight: '900',
    fontSize: 31,
    letterSpacing: -1.2,
  },
});
