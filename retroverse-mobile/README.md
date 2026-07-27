# Retroverse Mobile

Retroverse is a self-contained Expo React Native prototype for an original retro-inspired gaming hub. It includes a fictional catalog, three playable on-device games, persistent player progress, and a no-code mini-game builder. It does **not** contain ROMs, emulator code, proprietary characters, or third-party game assets.

## Run it

Requirements: Node.js 20+ and a recent Expo Go client or local iOS/Android simulator.

```bash
cd retroverse-mobile
npm install
npm run start
```

Then press `i` for iOS, `a` for Android, or scan the QR code with Expo Go.

Useful scripts:

```bash
npm run ios
npm run android
npm run web
npm run typecheck
npm run lint
```

## Product tour

- **Home:** featured game, continue playing, trends, categories, and a daily challenge.
- **Discover:** full-text search plus genre, era, and rating filters across 36 original placeholder titles.
- **Arcade:** locally implemented Snake-style, Breakout-style, and Memory Match games with touch controls, pause/restart, scores, and high scores.
- **Create:** configure a template, title, palette, difficulty, and speed; save it and launch the generated game immediately.
- **Library:** favorites, recent plays, creations, shareable configuration summaries, achievements, player stats, and profile.

## Architecture

```text
app/                  Expo Router routes and five-tab shell
  details/[id].tsx    Catalog detail route
  play/[id].tsx       Unified launcher for built-in and created games
src/
  components/         Shared cards, buttons, screen layout, and pixel effects
  data/               Original seeded catalog
  games/              Local game engines and shared arcade frame
  state/              Context-based app store and AsyncStorage persistence
  theme.ts            Design tokens
  types.ts            Domain types
```

`AppProvider` is the single persistence boundary. It hydrates favorites, recents, high scores, creations, and aggregate stats from AsyncStorage and exposes stable actions to the UI. A created game stores only a small typed configuration; the unified play route resolves that configuration to the corresponding local game engine.

## Design and accessibility

The visual system uses a midnight CRT palette, high-contrast neon signals, monospaced display type, tactile cards, glassy navigation, and transform/opacity press transitions. Interactive controls have accessibility roles and labels; screens include loading-safe local defaults and explicit empty states. Gameplay uses color plus shape/symbol cues.

## Prototype limitations

- Catalog entries beyond the three arcade titles are intentionally metadata-only.
- Sharing uses the native share sheet for a human-readable configuration summary; a portable import format and public gallery require a backend or deep-link contract.
- Profile identity, achievements, and daily challenge rotation are local prototype experiences.
- State is device-local and has no account sync or cloud backup.
