import { Platform } from 'react-native';

export const colors = {
  ink: '#07080D',
  panel: '#11131D',
  panelSoft: '#171A25',
  paper: '#F6F4EA',
  muted: '#8A8FA3',
  line: '#2A2E3C',
  lime: '#C8FF45',
  cyan: '#51E8FF',
  coral: '#FF5C7C',
  amber: '#FFC857',
  violet: '#9A7BFF',
  white: '#FFFFFF',
  black: '#000000',
};

export const spacing = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 44,
};

export const radius = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
};

export const type = {
  display: Platform.select({ ios: 'Courier New', android: 'monospace', default: 'monospace' }),
  body: Platform.select({ ios: 'Avenir Next', android: 'sans-serif', default: 'sans-serif' }),
};

export const shadow = {
  shadowColor: '#000',
  shadowOpacity: 0.35,
  shadowRadius: 18,
  shadowOffset: { width: 0, height: 8 },
  elevation: 8,
};
