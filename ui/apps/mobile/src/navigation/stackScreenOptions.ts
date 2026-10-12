import type { NativeStackNavigationOptions } from '@react-navigation/native-stack';
import type { SurfaceTheme } from '../components/ui/theme';

/** Every stack's header: the dark frame shared with the tab bar (docs/design.md §2 amendment),
 * a white title, the amber back control, and the canvas behind the screen. */
export function stackScreenOptions(theme: SurfaceTheme): NativeStackNavigationOptions {
  return {
    headerStyle: { backgroundColor: theme.shell.bg },
    headerTintColor: theme.shell.accent,
    headerTitleStyle: { color: theme.shell.fg, fontWeight: '700' },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: theme.canvas },
  };
}
