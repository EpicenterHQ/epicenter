/**
 * Whispering's capabilities (`app.ts`) as the pages read them in a page
 * that is not a Tauri window. Nothing here mocks a module.
 *
 * Key behaviors:
 * - A page without the Origin Private File System reads no folder, and
 *   says why, instead of keeping recordings elsewhere
 * - The models list the person's connections, then Ollama and LM Studio;
 *   a page has no global shortcut or speech, and keeps a key in this browser
 */
import './svelte-dom.test-support.js';
import { expect, test } from 'bun:test';

const { ai, folder, folderLocation, keysKept, shortcut, speech } = await import(
	'./app.js'
);

test('a page without the Origin Private File System reads no folder, and says why', async () => {
	// jsdom has no `navigator.storage`, as a page that cannot keep files has none.
	const loaded = await folder.load();
	expect(loaded.error).not.toBeNull();
	expect(folder.loadProblem()).not.toBeNull();
	expect(folderLocation()).toBeNull();
});

test('the models list the connections, then Ollama and LM Studio; a page has no shortcut or speech, and keeps keys in this browser', () => {
	expect(ai.endpoints().map(({ id }) => id)).toEqual(['ollama', 'lm-studio']);
	expect(shortcut).toBeNull();
	expect(speech).toBeNull();
	expect(keysKept).toBe('browser');
});
