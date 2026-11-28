/** A browser tab is opened by the person, never by the system. */
import { Err } from 'wellcrafted/result';
import type { Autostart } from './autostart';

export const browserAutostart: Autostart = {
	available: false,
	enabled: async () => false,
	set: async () => Err({ message: 'A browser tab cannot open at login.' }),
};
