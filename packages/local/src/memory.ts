/**
 * `@epicenter/local` under the `test` condition: this computer's settings
 * in memory, for the life of the process, empty at first and connected a
 * turn after the first file is named. A test writes what it needs through
 * the same `settings.file(name)` the code under test reads, and plays
 * another window with `outside`.
 */
import { createSettings } from './settings.js';

export {
	type Settings,
	SettingsError,
	type SettingsFile,
	SettingsNotOpen,
	type SettingsState,
} from './settings.js';

const files = new Map<string, string>();
const listeners = new Set<(names: readonly string[]) => void>();

/** This computer's settings for this app, in memory. */
export const settings = createSettings({
	async watch(changed) {
		listeners.add(changed);
		return () => listeners.delete(changed);
	},
	async read(name) {
		return files.get(name) ?? null;
	},
	async write(name, text) {
		if (text === null) files.delete(name);
		else files.set(name, text);
	},
});

/** Another window, or a person editing the file: writes `name` and is heard. */
export const outside = {
	write(name: string, text: string | null) {
		if (text === null) files.delete(name);
		else files.set(name, text);
		for (const changed of [...listeners]) changed([name]);
	},
	read: (name: string) => files.get(name) ?? null,
};
