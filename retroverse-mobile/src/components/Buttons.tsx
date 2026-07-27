import { Ionicons } from '@expo/vector-icons';
import { PropsWithChildren } from 'react';
import { Pressable, StyleProp, StyleSheet, Text, ViewStyle } from 'react-native';
import { colors, radius, spacing, type } from '@/theme';

type ButtonProps = PropsWithChildren<{
  onPress: () => void;
  icon?: keyof typeof Ionicons.glyphMap;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}>;

export function Button({ children, onPress, icon, variant = 'primary', disabled, style, accessibilityLabel }: ButtonProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      {icon ? <Ionicons name={icon} size={18} color={variant === 'primary' ? colors.ink : colors.paper} /> : null}
      <Text style={[styles.label, variant === 'primary' ? styles.labelDark : styles.labelLight]}>{children}</Text>
    </Pressable>
  );
}

export function IconButton({ icon, onPress, active, label }: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; active?: boolean; label: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.icon, active && styles.iconActive, pressed && styles.pressed]}
    >
      <Ionicons name={icon} size={20} color={active ? colors.ink : colors.paper} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderWidth: 1,
  },
  primary: { backgroundColor: colors.lime, borderColor: colors.lime },
  secondary: { backgroundColor: colors.panelSoft, borderColor: colors.line },
  ghost: { backgroundColor: 'transparent', borderColor: colors.line },
  pressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.35 },
  label: { fontFamily: type.display, fontSize: 13, fontWeight: '900', letterSpacing: 0.5 },
  labelDark: { color: colors.ink },
  labelLight: { color: colors.paper },
  icon: {
    width: 42,
    height: 42,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: colors.line,
  },
  iconActive: { backgroundColor: colors.coral, borderColor: colors.coral },
});
