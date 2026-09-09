import { Err, Ok, tryAsync } from 'wellcrafted/result';
import { TextError, type TextService } from './types.js';

export type { TextError, TextService } from './types.js';

export const TextServiceLive: TextService = {
	readFromClipboard: () =>
		tryAsync({
			try: async () => (await navigator.clipboard.readText()) || null,
			catch: (cause) => TextError.ClipboardRead({ cause }),
		}),
	copyToClipboard: (text) =>
		tryAsync({
			try: () => navigator.clipboard.writeText(text),
			catch: (cause) => TextError.ClipboardWrite({ cause }),
		}),
	async writeToCursor(text) {
		const result = await TextServiceLive.copyToClipboard(text);
		if (result.error) return Err(result.error);
		return Ok('leftOnClipboard');
	},
	async simulateEnterKeystroke() {
		return TextError.NotSupported({ operation: 'Simulating the Enter key' });
	},
	async simulateCopyKeystroke() {
		return TextError.NotSupported({
			operation: 'Copying another application’s selection',
		});
	},
};
