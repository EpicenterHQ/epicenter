/** A browser tab cannot run a model: it has none to list, and says so when asked to use one. */
import { Ok } from 'wellcrafted/result';
import { type Local, LocalFailure } from './local';

export const browserLocal: Local = {
	available: false,
	models: async () => Ok([]),
	download: async () => LocalFailure.Unavailable(),
	remove: async () => LocalFailure.Unavailable(),
	reveal: async () => LocalFailure.Unavailable(),
	transcribe: async () => LocalFailure.Unavailable(),
};
