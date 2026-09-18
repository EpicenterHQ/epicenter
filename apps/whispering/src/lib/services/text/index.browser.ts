import { clipboard } from '@epicenter/app/clipboard';
import { Ok } from 'wellcrafted/result';
import { TextError, type TextService } from './types.js';

export type { TextError, TextService } from './types.js';

export const TextServiceLive: TextService = {
	async writeToCursor(text) {
		const { error } = await clipboard.writeText(text);
		if (error) return TextError.WriteToCursor({ cause: error });
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
