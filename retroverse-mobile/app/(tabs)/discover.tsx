import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { EmptyState } from '@/components/EmptyState';
import { GameCard } from '@/components/GameCard';
import { GAME_CATALOG, GENRES } from '@/data/games';
import { colors, radius, spacing, type } from '@/theme';

type Era = 'All' | '80s' | '90s' | '00s';

export default function DiscoverScreen() {
  const params = useLocalSearchParams<{ genre?: string }>();
  const [query, setQuery] = useState('');
  const [genre, setGenre] = useState(params.genre && GENRES.includes(params.genre) ? params.genre : 'All');
  const [era, setEra] = useState<Era>('All');
  const [minRating, setMinRating] = useState(0);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return GAME_CATALOG.filter((game) => {
      const matchesQuery = !normalized || `${game.title} ${game.genre} ${game.tags.join(' ')}`.toLowerCase().includes(normalized);
      return matchesQuery && (genre === 'All' || game.genre === genre) && (era === 'All' || game.era === era) && game.rating >= minRating;
    });
  }, [query, genre, era, minRating]);

  return (
    <View style={styles.root}>
      <FlatList
        data={filtered}
        keyExtractor={(game) => game.id}
        numColumns={2}
        columnWrapperStyle={styles.columns}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
        renderItem={({ item }) => (
          <View style={styles.cardWrap}>
            <GameCard game={item} compact />
          </View>
        )}
        ListHeaderComponent={
          <View>
            <Text style={styles.eyebrow}>36 ORIGINAL TRANSMISSIONS</Text>
            <Text accessibilityRole="header" style={styles.title}>DISCOVER</Text>
            <View style={styles.search}>
              <Ionicons name="search" size={20} color={colors.cyan} />
              <TextInput
                accessibilityLabel="Search the game catalog"
                value={query}
                onChangeText={setQuery}
                placeholder="Search title, genre, mood..."
                placeholderTextColor={colors.muted}
                style={styles.input}
                returnKeyType="search"
              />
              {query ? (
                <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} hitSlop={8}>
                  <Ionicons name="close-circle" size={20} color={colors.muted} />
                </Pressable>
              ) : null}
            </View>

            <Text style={styles.filterLabel}>GENRE</Text>
            <FlatList
              data={GENRES}
              keyExtractor={(item) => item}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
              renderItem={({ item }) => <FilterChip label={item} active={genre === item} onPress={() => setGenre(item)} />}
            />

            <View style={styles.filterRow}>
              <View style={styles.filterGroup}>
                <Text style={styles.filterLabel}>ERA</Text>
                <View style={styles.chips}>
                  {(['All', '80s', '90s', '00s'] as Era[]).map((item) => <FilterChip key={item} label={item} active={era === item} onPress={() => setEra(item)} />)}
                </View>
              </View>
              <View style={styles.filterGroup}>
                <Text style={styles.filterLabel}>RATING</Text>
                <View style={styles.chips}>
                  {[0, 4.5, 4.8].map((rating) => <FilterChip key={rating} label={rating ? `${rating}+` : 'Any'} active={minRating === rating} onPress={() => setMinRating(rating)} />)}
                </View>
              </View>
            </View>
            <View style={styles.resultRow}>
              <Text style={styles.result}>{filtered.length} GAMES FOUND</Text>
              <View style={styles.rule} />
            </View>
          </View>
        }
        ListEmptyComponent={<EmptyState icon="search" title="No signal found" body="Try a different title or widen your filters." />}
      />
    </View>
  );
}

function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.pressed]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  content: { paddingHorizontal: spacing.md, paddingBottom: 132 },
  eyebrow: { color: colors.lime, fontFamily: type.display, fontWeight: '900', fontSize: 10, letterSpacing: 1.8, marginTop: spacing.md },
  title: { color: colors.paper, fontFamily: type.display, fontWeight: '900', fontSize: 34, letterSpacing: -1.5, marginTop: 5 },
  search: { height: 54, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, marginTop: spacing.lg, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: { flex: 1, color: colors.paper, fontFamily: type.body, fontSize: 14 },
  filterLabel: { color: colors.muted, fontFamily: type.display, fontWeight: '900', fontSize: 9, letterSpacing: 1.5, marginTop: spacing.lg, marginBottom: spacing.sm },
  chips: { flexDirection: 'row', gap: 8, paddingRight: spacing.md },
  chip: { height: 34, paddingHorizontal: 13, borderRadius: radius.pill, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  chipActive: { backgroundColor: colors.lime, borderColor: colors.lime },
  chipText: { color: colors.muted, fontFamily: type.display, fontSize: 10, fontWeight: '900' },
  chipTextActive: { color: colors.ink },
  pressed: { opacity: 0.7 },
  filterRow: { flexDirection: 'row', gap: spacing.lg },
  filterGroup: { flex: 1 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xl, marginBottom: spacing.md },
  result: { color: colors.cyan, fontFamily: type.display, fontWeight: '900', fontSize: 10 },
  rule: { flex: 1, height: 1, backgroundColor: colors.line },
  columns: { gap: spacing.sm },
  cardWrap: { flex: 1, marginBottom: spacing.sm },
});
