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

const { ai, folderLocation, keysKept, query, shortcut, speech } = await import(
	'./app.js'
);
const { runQuery } = await import('wellcrafted/query');

test('a page without the Origin Private File System reads no folder, and says why', async () => {
	// jsdom has no `navigator.storage`, as a page that cannot keep files has none.
	const read = await runQuery(query.queryClient, query.folderQueries.read());
	// The reason names what failed and why: the page has no file system.
	expect(read.error?.message).toMatch(
		/^Could not list recordings: .*navigator\.storage/,
	);
	expect(folderLocation()).toBeNull();
});

test('the models list the connections, then Ollama and LM Studio; a page has no shortcut or speech, and keeps keys in this browser', () => {
	expect(ai.endpoints().map(({ id }) => id)).toEqual(['ollama', 'lm-studio']);
	expect(shortcut).toBeNull();
	expect(speech).toBeNull();
	expect(keysKept).toBe('browser');
});
