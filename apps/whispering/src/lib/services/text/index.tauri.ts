import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Ok, tryAsync } from 'wellcrafted/result';
import { commands } from '$lib/tauri/commands';
import type { TextService } from './types';
import { TextError } from './types';

export type { TextError, TextService } from './types';

export const TextServiceLive: TextService = {
	readFromClipboard: () =>
		tryAsync({
			try: async () => {
				const text = await readText();
				return text ?? null;
			},
			catch: (error) => TextError.ClipboardRead({ cause: error }),
		}),

	copyToClipboard: (text) =>
		tryAsync({
			try: () => writeText(text),
			catch: (error) => TextError.ClipboardWrite({ cause: error }),
		}),

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

	simulateCopyKeystroke: async () => {
		const { error } = await commands.simulateCopyKeystroke();
		if (error !== null) return TextError.SimulateKeystroke({ cause: error });
		return Ok(undefined);
	},
};
