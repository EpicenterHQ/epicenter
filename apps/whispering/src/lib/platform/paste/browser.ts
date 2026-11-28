/** A browser tab cannot press a key in another app. */
import { Err } from 'wellcrafted/result';
import type { Paste } from './paste';

export const browserPaste: Paste = {
	available: false,
	allowed: async () => false,
	ask: async () => {},
	press: async () =>
		Err({ message: 'A browser tab cannot paste into another app.' }),
};
