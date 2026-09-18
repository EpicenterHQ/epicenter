import { clipboard } from '@epicenter/app/clipboard';
import { tauri } from '#platform/tauri';
import { report } from '$lib/report';
import { recipePicker } from '$lib/state/recipe-picker.svelte';

/**
 * Read the clipboard, then raise the in-app recipe picker over it. The user
 * picks a recipe and the picker runs it on the clipboard text. On desktop the
 * Whispering window is focused first so the palette is visible even when the
 * shortcut fired from another app; on web the picker just opens. See ADR-0099.
 */
export async function runRecipeOnClipboard() {
	const { data: text, error } = await clipboard.readText();
	if (error) {
		report.error({ title: "Couldn't read your clipboard", cause: error });
		return;
	}
	const input = text?.trim() ? text : '';
	if (!input) {
		report.info({
			title: 'Your clipboard is empty',
			description: 'Copy some text, then run a recipe on it.',
		});
		return;
	}
	await tauri?.mainWindow.focus();
	recipePicker.open(input);
}
