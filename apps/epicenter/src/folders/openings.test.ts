/** The launcher asks native code to open editors and never acquires their folders. */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { AcceptedOpening, RememberedFolders } from '../ui/bindings.gen';
import type { OpeningHost } from './openings.svelte';

const { createFolderOpenings, folderName } = await import(
	'./openings.svelte.ts'
);
const path = '/Users/me/Library/Application Support/so.epicenter.todos';
function fixture() {
	const calls: string[] = [];
	const pending = new Set([path]);
	let listed: RememberedFolders = { folders: [], problem: null };
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
			listed = {
				folders: [
					{ path, remembered: rememberProblem === null, problem: null },
				],
				problem: null,
			};
			return { data: { rememberProblem }, error: null };
		},
		async openRememberedFolder(path) {
			calls.push('open ' + path);
			return { data: null, error: problem };
		},
		async dismissFolderOpening(path) {
			calls.push('dismiss ' + path);
			pending.delete(path);
		},
		async listRememberedFolders() {
			calls.push('list');
			return listed;
		},
		async forgetRememberedFolder(path) {
			calls.push('forget ' + path);
			return { data: null, error: problem };
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
test('acceptance asks native code to open a separate editor and refreshes shortcuts', async () => {
	const f = fixture();
	await f.openings.accept(path);
	expect(f.calls).toEqual(['accept ' + path, 'pending', 'list']);
	expect(f.openings.requests).toEqual([]);
	expect(f.openings.remembered?.folders[0]?.path).toBe(path);
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
	expect(f.openings.remembered?.folders[0]?.remembered).toBe(false);
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
test('reopening calls the native membership check and refreshes availability', async () => {
	const f = fixture();
	f.refuse('This folder is not in the remembered folders.');
	await f.openings.open(path);
	expect(f.calls).toEqual(['open ' + path, 'list']);
	expect(f.openings.failure).toContain('not in the remembered folders');
});
test('a failed forgetting stays listed and says why', async () => {
	const f = fixture();
	await f.openings.accept(path);
	f.refuse('folders.json was left unchanged.');
	await f.openings.forget(path);
	expect(f.openings.failure).toContain('did not forget');
	expect(f.openings.remembered?.folders[0]?.path).toBe(path);
});
test('native rejection is shown even when the invocation throws', async () => {
	const f = fixture();
	f.host.openRememberedFolder = async () => {
		throw new Error('window failed');
	};
	await f.openings.open(path);
	expect(f.openings.failure).toContain('window failed');
});
test('folder names work for platform paths', () => {
	expect(folderName(path)).toBe('so.epicenter.todos');
	expect(folderName('C:\\Users\\me\\Notes')).toBe('Notes');
	expect(folderName('/')).toBe('/');
});
