import { Ok } from 'wellcrafted/result';
import { commands } from '$lib/tauri/commands';
import type { TextService } from './types';
import { TextError } from './types';

export type { TextError, TextService } from './types';

export const TextServiceLive: TextService = {
	writeToCursor: async (text, keepOnClipboard) => {
		const { data, error } = await commands.writeText(text, keepOnClipboard);
		if (error !== null) return TextError.WriteToCursor({ cause: error });
		return Ok(data);
	},

	simulateEnterKeystroke: async () => {
		const { error } = await commands.simulateEnterKeystroke();
		if (error !== null) return TextError.SimulateKeystroke({ cause: error });
		return Ok(undefined);
	},

};
