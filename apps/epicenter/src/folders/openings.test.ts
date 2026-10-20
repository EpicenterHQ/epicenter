/**
 * Folder Openings Tests
 *
 * Drives the Folders window's answer to another app's "Open in Epicenter"
 * over a stand-in shell and the window's real folder switch, whose folders
 * are stand-ins that a test can hold a save open on.
 *
 * Key behaviors:
 * - A request is shown and nothing is accepted, opened, or read until the
 *   person accepts it; dismissing it accepts nothing
 * - An accepted folder opens through the folder switch when nothing typed is
 *   unsaved
 * - With unsaved typing in the open folder, an accepted folder is only listed;
 *   choosing it later leaves the open folder the safe way
 * - A refused acceptance opens nothing and says why
 * - A folder Epicenter could not remember still opens, and the window says so
 * - A forgetting that failed is shown
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { describe, expect, test } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { AcceptedOpening, RememberedFolders } from '../ui/bindings.gen';

const { createFolderSwitch } = await import('./folder-switch.svelte.ts');
const { createFolderOpenings, folderName } = await import(
	'./openings.svelte.ts'
);

type Saved = Result<void, SaveError | Error>;

const TODOS = '/Users/me/Library/Application Support/so.epicenter.todos';
const text = { content: 'a\n', crlf: false };

/** A folder whose every save waits for the test to answer it. */
function standIn(id: string, log: string[]) {
	const held: ((result: Saved) => void)[] = [];
	const folder = {
		files: {
			write(path: string) {
				log.push(`${id}: write ${path}`);
				return new Promise<Saved>((answer) => held.push(answer));
			},
		},
		onChange: () => () => {},
		async close() {
			log.push(`${id}: close`);
		},
	} as unknown as Folder<Record<never, never>>;
	return { folder, held };
}

/** Wait until `done`, letting promises run between checks. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 50; turn++) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Never happened');
}

/**
 * The shell's side: requests it holds, and what accepting one answers. Every
 * call is logged, so a test sees which ones the window made.
 */
function shell(log: string[]) {
	const pending = new Set<string>();
	const listed: RememberedFolders = { folders: [], problem: null };
	let answer:
		| { data: AcceptedOpening; error: null }
		| { data: null; error: string } = {
		data: { id: 'opened:1', rememberProblem: null },
		error: null,
	};
	let forgetting: string | null = null;
	return {
		/** An app's request reaching the shell. */
		request(path: string) {
			pending.add(path);
		},
		answerWith(next: typeof answer) {
			answer = next;
		},
		refuseForgetting(message: string) {
			forgetting = message;
		},
		host: {
			async pendingFolderOpenings() {
				log.push('shell: pending');
				return [...pending];
			},
			async acceptFolderOpening(path: string) {
				log.push(`shell: accept ${path}`);
				pending.delete(path);
				if (answer.error === null)
					listed.folders = [
						{
							path,
							id: answer.data.id,
							remembered: answer.data.rememberProblem === null,
							problem: null,
						},
					];
				return answer;
			},
			async dismissFolderOpening(path: string) {
				log.push(`shell: dismiss ${path}`);
				pending.delete(path);
			},
			async listRememberedFolders() {
				log.push('shell: list');
				return { ...listed };
			},
			async forgetRememberedFolder(path: string) {
				log.push(`shell: forget ${path}`);
				if (forgetting !== null) return { data: null, error: forgetting };
				listed.folders = listed.folders.filter(
					(folder) => folder.path !== path,
				);
				return { data: null, error: null };
			},
		},
	};
}

/** The Folders window: its folder switch over stand-ins, and its openings. */
function windowOver(log: string[]) {
	const opened = new Map<string, ReturnType<typeof standIn>>();
	const current = createFolderSwitch({
		async open(id) {
			log.push(`${id}: open`);
			const folder = standIn(id, log);
			opened.set(id, folder);
			return Ok(folder.folder);
		},
		watch: () => () => {},
		saved: async () => {},
	});
	const desktop = shell(log);
	const openings = createFolderOpenings({ host: desktop.host, current });
	return { current, opened, desktop, openings };
}

describe('a request to open a folder', () => {
	test('is shown, and nothing is accepted or opened until the person accepts it', async () => {
		const log: string[] = [];
		const { current, desktop, openings } = windowOver(log);
		desktop.request(TODOS);
		await openings.refresh();

		expect(openings.requests).toEqual([TODOS]);
		expect(log).toEqual(['shell: pending']);
		expect(current.chosen).toBeUndefined();

		await openings.accept(TODOS);
		expect(log).toContain(`shell: accept ${TODOS}`);
		expect(openings.requests).toEqual([]);
		expect(current.opened?.id).toBe('opened:1');
		expect(openings.remembered?.folders.map((folder) => folder.path)).toEqual([
			TODOS,
		]);
		expect(openings.notice).toBeUndefined();
		expect(openings.failure).toBeUndefined();
	});

	test('dismissed, accepts and opens nothing', async () => {
		const log: string[] = [];
		const { current, desktop, openings } = windowOver(log);
		desktop.request(TODOS);
		await openings.refresh();

		await openings.dismiss(TODOS);
		expect(openings.requests).toEqual([]);
		expect(log.some((line) => line.startsWith('shell: accept'))).toBe(false);
		expect(current.chosen).toBeUndefined();
	});

	test('acceptance waits for unfinished typing to save before switching', async () => {
		const log: string[] = [];
		const { current, opened, desktop, openings } = windowOver(log);
		await current.choose('data:notes');
		current.opened!.drafts.file('plan.md').type('a\nmine\n', text);
		desktop.request(TODOS);
		await openings.refresh();

		const accepting = openings.accept(TODOS);
		await until(() => opened.get('data:notes')!.held.length === 1);
		expect(current.opened?.id).toBe('data:notes');
		expect(current.opened?.drafts.held).toEqual(['plan.md']);
		expect(log).not.toContain('data:notes: close');
		expect(log).not.toContain('opened:1: open');
		opened.get('data:notes')!.held.shift()!(Ok(undefined));
		await accepting;
		expect(current.opened?.id).toBe('opened:1');
		expect(openings.remembered?.folders[0]?.id).toBe('opened:1');
		expect(log.indexOf('data:notes: close')).toBeGreaterThan(
			log.indexOf('data:notes: write plan.md'),
		);
	});

	test('a failed save keeps the open folder and its draft', async () => {
		const log: string[] = [];
		const { current, opened, desktop, openings } = windowOver(log);
		await current.choose('data:notes');
		current.opened!.drafts.file('plan.md').type('a\nmine\n', text);
		desktop.request(TODOS);
		await openings.refresh();

		const accepting = openings.accept(TODOS);
		await until(() => opened.get('data:notes')!.held.length === 1);
		opened.get('data:notes')!.held.shift()!(Err(new Error('disk full')));
		await accepting;
		expect(current.opened?.id).toBe('data:notes');
		expect(current.opened?.drafts.held).toEqual(['plan.md']);
		expect(current.kept?.map((draft) => draft.path)).toEqual(['plan.md']);
		expect(openings.remembered?.folders[0]?.id).toBe('opened:1');
	});

	test('refused, opens nothing and says why', async () => {
		const log: string[] = [];
		const { current, desktop, openings } = windowOver(log);
		desktop.request(TODOS);
		desktop.answerWith({ data: null, error: 'This folder is not there.' });
		await openings.refresh();

		await openings.accept(TODOS);
		expect(openings.failure).toBe(
			`${TODOS} did not open. This folder is not there.`,
		);
		expect(current.chosen).toBeUndefined();
		expect(openings.requests).toEqual([]);
	});

	test('that Epicenter could not remember still opens, and says so', async () => {
		const log: string[] = [];
		const { current, desktop, openings } = windowOver(log);
		desktop.request(TODOS);
		desktop.answerWith({
			data: {
				id: 'opened:1',
				rememberProblem: 'folders.json was left unchanged.',
			},
			error: null,
		});
		await openings.refresh();

		await openings.accept(TODOS);
		expect(current.opened?.id).toBe('opened:1');
		expect(openings.notice).toBe(
			'Epicenter could not update its remembered folders. folders.json was left unchanged.',
		);
		expect(openings.remembered?.folders[0]?.remembered).toBe(false);
	});

	test('a second acceptance waits until the first finishes choosing', async () => {
		const a = '/tmp/A';
		const b = '/tmp/B';
		let releaseList!: (value: RememberedFolders) => void;
		const firstList = new Promise<RememberedFolders>((resolve) => {
			releaseList = resolve;
		});
		let listed = false;
		const accepted: string[] = [];
		const chosen: string[] = [];
		const pending = new Set([a, b]);
		const openings = createFolderOpenings({
			host: {
				pendingFolderOpenings: async () => [...pending],
				acceptFolderOpening: async (path) => {
					accepted.push(path);
					pending.delete(path);
					return { data: { id: path, rememberProblem: null }, error: null };
				},
				dismissFolderOpening: async () => {},
				listRememberedFolders: () => {
					listed = true;
					return firstList;
				},
				forgetRememberedFolder: async () => ({ data: null, error: null }),
			},
			current: {
				opened: undefined,
				choose: async (id) => {
					chosen.push(id);
				},
			},
		});
		const first = openings.accept(a);
		await until(() => listed);
		await openings.accept(b);
		expect(accepted).toEqual([a]);
		expect(chosen).toEqual([]);
		releaseList({ folders: [], problem: null });
		await first;
		await openings.accept(b);
		expect(accepted).toEqual([a, b]);
		expect(chosen).toEqual([a, b]);
	});
});

describe('a remembered folder', () => {
	test('that could not be forgotten stays listed and says why', async () => {
		const log: string[] = [];
		const { desktop, openings } = windowOver(log);
		desktop.request(TODOS);
		await openings.refresh();
		await openings.accept(TODOS);

		desktop.refuseForgetting('folders.json was left unchanged.');
		await openings.forget(TODOS);
		expect(openings.failure).toBe(
			`Epicenter did not forget ${TODOS}. folders.json was left unchanged.`,
		);
		expect(openings.remembered?.folders.map((folder) => folder.path)).toEqual([
			TODOS,
		]);
	});

	test('is named by the last segment of its path', () => {
		expect(folderName(TODOS)).toBe('so.epicenter.todos');
		expect(folderName('C:\\Users\\me\\Notes')).toBe('Notes');
		expect(folderName('/')).toBe('/');
	});
});
