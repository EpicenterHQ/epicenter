/** Test fixture: the parts of a text session FileView reads and calls, with a reactive draft. */
import type { TextSession } from '../../edit-session.svelte.js';

export function fakeTextSession(initial: string) {
	const typed: string[] = [];
	let draft = $state.raw(initial);
	const session = {
		get draft() {
			return draft;
		},
		state: {
			status: 'saved',
			file: { path: 'tasks/walk.md', sha256: 'a'.repeat(64) },
		},
		locked: false,
		retry() {},
		input(text: string) {
			typed.push(text);
			draft = text;
		},
	};
	return { session: session as unknown as TextSession, typed };
}
