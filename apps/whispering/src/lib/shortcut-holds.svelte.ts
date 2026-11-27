/**
 * Which global shortcuts are held now, for any screen: what could not be
 * held and why, and a pause while a new shortcut is being read from the
 * keyboard, so pressing the old one does not start a take.
 *
 * The main window's layout calls `apply` whenever the settings' shortcuts
 * change; the Shortcuts page reads `problem` and pauses.
 */
import { shortcuts } from './platform';
import type { ShortcutName } from './platform/shortcuts/shortcuts';
import { isMac, sameShortcut } from './shortcut';

const NONE: Record<ShortcutName, string> = {
	toggle: '',
	hold: '',
	handsFree: '',
};

let problems = $state<Partial<Record<ShortcutName, string>>>({});
let paused = $state(false);

export const shortcutHolds = {
	/** Why the shortcut `name` is not held, or undefined when it is, or is off. */
	problem: (name: ShortcutName) => problems[name],
	paused: () => paused,
	/** Let every shortcut go while `on`, so a key press can be read as a new one. */
	pause(on: boolean) {
		paused = on;
	},
	/** Hold `keys`, or nothing while paused, and keep what could not be held. */
	async apply(keys: Record<ShortcutName, string>) {
		const [first, second, third] = [keys.toggle, keys.hold, keys.handsFree];
		const twice: Partial<Record<ShortcutName, string>> = {};
		// The same keys for two things would do both; the later one is left off.
		const same = (a: string, b: string) =>
			!!a && !!b && sameShortcut(a, b, isMac());
		if (same(second, first))
			twice.hold = 'Start and stop already uses these keys.';
		if (same(third, first) || same(third, second))
			twice.handsFree = 'Another shortcut already uses these keys.';
		const wanted = paused
			? NONE
			: {
					toggle: first,
					hold: twice.hold ? '' : second,
					handsFree: twice.handsFree ? '' : third,
				};
		const unheld = await shortcuts.set(wanted).catch(() => ({}));
		problems = { ...unheld, ...twice };
	},
};
