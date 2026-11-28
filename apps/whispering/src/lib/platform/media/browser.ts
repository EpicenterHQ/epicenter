/** A browser tab cannot pause another app's media. */
import type { Media } from './media';

export const browserMedia: Media = {
	pause: async () => [],
	resume: async () => {},
};
