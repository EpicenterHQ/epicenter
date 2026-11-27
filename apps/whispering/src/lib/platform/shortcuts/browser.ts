/** A browser tab has no global shortcuts: it holds none and hears none. */
import type { Shortcuts } from './shortcuts';

export const browserShortcuts: Shortcuts = {
	available: false,
	set: async () => ({}),
	onPress: () => () => {},
};
