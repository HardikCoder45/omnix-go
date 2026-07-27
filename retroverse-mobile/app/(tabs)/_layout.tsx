import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { BlurView } from 'expo-blur';
import { StyleSheet } from 'react-native';
import { colors, type } from '@/theme';

const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
  index: 'home',
  discover: 'search',
  arcade: 'game-controller',
  create: 'add-circle',
  library: 'person',
};

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: colors.lime,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: styles.label,
        tabBarStyle: styles.bar,
        tabBarBackground: () => <BlurView intensity={70} tint="dark" style={StyleSheet.absoluteFill} />,
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons name={focused ? icons[route.name] : (`${icons[route.name]}-outline` as keyof typeof Ionicons.glyphMap)} color={color} size={focused ? size + 2 : size} />
        ),
      })}
    >
      <Tabs.Screen name="index" options={{ title: 'HOME' }} />
      <Tabs.Screen name="discover" options={{ title: 'DISCOVER' }} />
      <Tabs.Screen name="arcade" options={{ title: 'ARCADE' }} />
      <Tabs.Screen name="create" options={{ title: 'CREATE' }} />
      <Tabs.Screen name="library" options={{ title: 'LIBRARY' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    height: 82,
    paddingTop: 8,
    paddingBottom: 16,
    backgroundColor: 'rgba(7,8,13,0.86)',
    borderTopColor: colors.line,
  },
  label: { fontFamily: type.display, fontSize: 9, fontWeight: '900', letterSpacing: 0.4 },
});
