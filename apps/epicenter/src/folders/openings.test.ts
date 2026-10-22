/** The launcher asks native code to open editors and never acquires their folders. */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AcceptedOpening } from '../ui/bindings.gen';
import type { OpeningHost } from './openings.svelte';

const { createFolderOpenings, folderName } = await import(
	'./openings.svelte.ts'
);
const path = '/Users/me/Library/Application Support/so.epicenter.todos';
function fixture() {
	const calls: string[] = [];
	const pending = new Set([path]);
	let problem: string | null = null;
	let rememberProblem: string | null = null;
	const host: OpeningHost = {
		async pendingFolderOpenings() {
			calls.push('pending');
			return [...pending];
		},
		async acceptFolderOpening(path) {
			calls.push('accept ' + path);
			pending.delete(path);
			if (problem !== null) return { data: null, error: problem };
			return { data: { rememberProblem }, error: null };
		},
		async dismissFolderOpening(path) {
			calls.push('dismiss ' + path);
			pending.delete(path);
		},
	};
	return {
		calls,
		host,
		pending,
		openings: createFolderOpenings({ host }),
		refuse(message: string) {
			problem = message;
		},
		failRemembering(message: string) {
			rememberProblem = message;
		},
	};
}
test('listing a request does not accept or open it', async () => {
	const f = fixture();
	await f.openings.refresh();
	expect(f.openings.requests).toEqual([path]);
	expect(f.calls).toEqual(['pending']);
});
test('dismissal accepts and opens nothing', async () => {
	const f = fixture();
	await f.openings.dismiss(path);
	expect(f.openings.requests).toEqual([]);
	expect(f.calls).toEqual(['dismiss ' + path, 'pending']);
});
test('acceptance asks native code to open a separate editor and refreshes pending requests', async () => {
	const f = fixture();
	await f.openings.accept(path);
	expect(f.calls).toEqual(['accept ' + path, 'pending']);
	expect(f.openings.requests).toEqual([]);
	expect(f.openings.failure).toBeUndefined();
});
test('refusal stays visible without a second open request', async () => {
	const f = fixture();
	f.refuse('This folder is not there.');
	await f.openings.accept(path);
	expect(f.openings.failure).toBe(
		path + ' did not open. This folder is not there.',
	);
	expect(f.calls.filter((c) => c.startsWith('open '))).toEqual([]);
});
test('failed remembering leaves the opened folder available this run and says why', async () => {
	const f = fixture();
	f.failRemembering('folders.json was left unchanged.');
	await f.openings.accept(path);
	expect(f.openings.notice).toContain('folders.json was left unchanged.');
});
test('a second acceptance waits until the first completes', async () => {
	const f = fixture();
	let finish!: (value: { data: AcceptedOpening; error: null }) => void;
	f.host.acceptFolderOpening = async (path) => {
		f.calls.push('accept ' + path);
		return new Promise((resolve) => {
			finish = resolve;
		});
	};
	const first = f.openings.accept(path);
	await f.openings.accept('/tmp/other');
	expect(f.calls).toEqual(['accept ' + path]);
	finish({ data: { rememberProblem: null }, error: null });
	await first;
	expect(f.openings.accepting).toBeUndefined();
});
test('folder names work for platform paths', () => {
	expect(folderName(path)).toBe('so.epicenter.todos');
	expect(folderName('C:\\Users\\me\\Notes')).toBe('Notes');
	expect(folderName('/')).toBe('/');
});
