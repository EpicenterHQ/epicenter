/**
 * Close Consent Tests
 *
 * Runs the production page client and the real notes state, with real edits
 * written through its query cache, against the shell's real close gate. The
 * client's `invoke` and `listen` are Tauri's own, answered through Tauri's
 * IPC mocks by the gate in the `harness` example. Run with
 * `bun run test:native`.
 *
 * This is not the desktop app: no window closes here. It shows that the page
 * and the gate agree on every decision.
 *
 * The folder is the real browser folder over the in-memory OPFS stand-in. A
 * write that fails, waits, or loses its reply does so in the stand-in's file
 * streams; nothing wraps the notes state. That proves the page's close
 * handling against the real gate, not the desktop folder's native storage:
 * those writes go through the shell's folder plugin, which
 * `src-tauri/src/tests.rs` and the folder package test.
 *
 * Key behaviors:
 * - A close while the folder is opening, or after it failed to open, proceeds
 * - Once the folder is held, a close proceeds only on the page's approval
 * - The page approves once every write and action has landed, and never
 *   asks: a write that failed was rolled back and reported, and holds
 *   nothing
 * - A change to a file with no open view is waited for; one whose reply was
 *   lost is reported and does not hold the close
 * - Input is fenced before writes are waited for and while the approval is
 *   on its way; a refused approval releases it
 * - A declined, replaced, or earlier page's approval is never replayed
 * - A page that stops answering is asked again and never bypassed
 */
import '../src/lib/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { type FileCapture, parseRow } from '@epicenter/folder';
import { undoDepth } from 'prosemirror-history';
import { EditorState, type Transaction } from 'prosemirror-state';
import { honeycrispDefinition } from '../src/lib/data.js';
import { bodyCodec } from '../src/lib/editor/markdown.js';
import { openNotesFolder } from '../src/lib/folder.test-support.js';
import type { WriteFailure } from '../src/lib/notes.svelte.js';
import {
	type CloseRequest,
	openGuarded,
	registerPage,
} from '../src/lib/platform/shell.tauri.js';
import type { NotesHost } from '../src/lib/platform/types.js';
import {
	createQueryClient,
	observe,
	quiet,
} from '../src/lib/query.test-support.js';
import { createGateShell } from './gate.js';

const { createNotes } = await import('../src/lib/notes.svelte.ts');
// The rich-text rules read the notes state, a runes module.
const { editingPlugins, stateAfter } = await import(
	'../src/lib/editor/rich-text.js'
);

const NOTE_PATH = 'notes/a.md';
const NOTE = [
	'---',
	'title: A',
	'# kept',
	'extra: 1',
	'folderId: null',
	'pinned: false',
	'createdAt: "2026-10-01T00:00:00.000Z"',
	'updatedAt: "2026-10-01T00:00:00.000Z"',
	'deletedAt: null',
	'---',
	'body',
	'',
].join('\n');
const RAW_PATH = 'kv.json';
const RAW = '{}\n';

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const stop of cleanup.splice(0)) stop();
});

function shell() {
	const gate = createGateShell();
	cleanup.push(gate.dispose);
	return gate;
}

async function until(check: () => boolean, what: string) {
	for (let attempt = 0; attempt < 500; attempt += 1) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error(`Timed out waiting for ${what}`);
}

/**
 * The real browser folder over the folder package's in-memory OPFS stand-in,
 * with one note and one raw file. The note is edited by the production row
 * editor, and nothing wraps it: every write, a note's included, can be made
 * to fail, to wait until released, or to land and lose its reply where the
 * folder writes, in the stand-in's file streams, as a full disk, a slow one,
 * or a lost reply would. Raw file reads can be made to wait too.
 */
async function folder() {
	const disk = await openNotesFolder();
	// Below the folder's API, before the page opens: no hint, no history.
	disk.put(NOTE_PATH, NOTE);
	disk.put(RAW_PATH, RAW);
	cleanup.push(() => void disk.close());

	let heldReads: PromiseWithResolvers<void> | undefined;
	let reading = 0;
	let moves = 0;
	let closed = 0;
	const real = disk.folder;
	const host = {
		...disk.host,
		folder: {
			...real,
			files: {
				...real.files,
				read: async (path: string) => {
					reading += 1;
					try {
						await heldReads?.promise;
					} finally {
						reading -= 1;
					}
					return real.files.read(path);
				},
				move: (file: FileCapture, to: string) => {
					moves += 1;
					return real.files.move(file, to);
				},
			},
		},
		close: async () => {
			closed += 1;
			await disk.close();
		},
	} satisfies NotesHost;

	return {
		host,
		/** How the notes table reads text. */
		parse: (text: string) => parseRow(honeycrispDefinition.tables.notes, text),
		saved: disk.text,
		/** Another program writes the file, as the shell's terminal could. */
		outside: disk.put,
		/** Writes fail before anything is published, as on a full disk. */
		failWrites: disk.failWrites,
		holdWrites: disk.hold,
		releaseWrites: () => disk.release({ all: true }),
		get waitingWrites() {
			return disk.held().length;
		},
		/** Writes land, and their replies never arrive. */
		loseReplies: () => disk.loseReplies(),
		holdReads() {
			heldReads = Promise.withResolvers<void>();
		},
		releaseReads() {
			heldReads?.resolve();
			heldReads = undefined;
		},
		get waitingReads() {
			return reading;
		},
		get moves() {
			return moves;
		},
		/** Every file of the folder, outside its history. */
		paths: disk.paths,
		get closed() {
			return closed;
		},
	};
}

/** Start a page the way `+page.svelte` does: guarded, then the real notes state. */
function page(
	acquire: () => Promise<NotesHost>,
	create?: (host: NotesHost) => Promise<ReturnType<typeof createNotes>>,
) {
	const problems: unknown[] = [];
	/** Each write that failed and was rolled back, as the page's toast reports it. */
	const failures: WriteFailure[] = [];
	const opening = openGuarded({
		acquire,
		create:
			create ??
			(async (host) => {
				const notes = createNotes(host, createQueryClient(), {
					onWriteFailed: (failure) => failures.push(failure),
				});
				cleanup.push(observe(notes));
				await notes.load();
				return notes;
			}),
		report: (cause) => problems.push(cause),
	});
	return { opening, problems, failures };
}

/** An open page over a fresh folder, with the raw file open as text. */
async function editing(path: string) {
	const gate = shell();
	const disk = await folder();
	const { opening, problems, failures } = page(async () => disk.host);
	const notes = await opening;
	notes.open(path);
	cleanup.push(observe(notes, path));
	await quiet(notes);
	return {
		gate,
		disk,
		notes,
		problems,
		failures,
		/** Type `text` as the file view does; answers whether it was taken. */
		edit: (text: string) => notes.editText(path, text),
	};
}

/** An open page over a fresh folder, with the note open and its rich-text view on its body. */
async function editingNote() {
	const gate = shell();
	const disk = await folder();
	const { opening, problems, failures } = page(async () => disk.host);
	const notes = await opening;
	notes.open(NOTE_PATH);
	const note = notes.noteBody(NOTE_PATH);
	const opened = bodyCodec.decode(note.row?.body ?? '');
	if (!opened.supported) throw new Error('The note is not rich text');
	/** The rich-text view's state, and the state it shows after a transaction. */
	const rich = {
		state: EditorState.create({
			doc: opened.doc,
			plugins: editingPlugins(),
		}),
		apply(transaction: Transaction) {
			const next = stateAfter(rich.state, transaction, note, () => {});
			if (next !== undefined) rich.state = next;
			return next;
		},
	};
	return { gate, disk, notes, note, rich, problems, failures };
}

// ============================================================================
// Before the notes exist
// ============================================================================

test('a close before any page registered proceeds', async () => {
	expect(await shell().close()).toBe('proceed');
});

test('a close while the folder is opening proceeds, and the folder that arrives afterward is closed unshown', async () => {
	const gate = shell();
	const disk = await folder();
	const acquiring = Promise.withResolvers<NotesHost>();
	let created = 0;
	const { opening } = page(
		() => acquiring.promise,
		async (host) => {
			created += 1;
			return createNotes(host, createQueryClient());
		},
	);
	await until(() => gate.steps.includes('register'), 'the page to register');
	expect(await gate.close()).toBe('proceed');
	acquiring.resolve(disk.host);
	await expect(opening).rejects.toBe('the app is already closing');
	expect(created).toBe(0);
	expect(disk.closed).toBe(1);
});

test('a close after the folder failed to open proceeds', async () => {
	const gate = shell();
	const { opening } = page(async () => {
		throw new Error('Another Epicenter is already using the folder');
	});
	await expect(opening).rejects.toThrow(
		'Another Epicenter is already using the folder',
	);
	expect(gate.steps).toEqual(['register']);
	expect(await gate.close()).toBe('proceed');
});

test('a page whose notes failed to start after the folder was held still answers a close', async () => {
	const gate = shell();
	const disk = await folder();
	const { opening } = page(
		async () => disk.host,
		async () => {
			throw new Error('The listing could not be read');
		},
	);
	await expect(opening).rejects.toThrow('The listing could not be read');
	expect(disk.closed).toBe(1);
	expect(await gate.close()).toBe('held');
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(await gate.close()).toBe('proceed');
});

// ============================================================================
// Writes
// ============================================================================

test('a page with no write running approves a close without asking the person', async () => {
	const { gate } = await editing(RAW_PATH);
	expect(await gate.close()).toBe('held');
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(gate.accepted('decline')).toEqual([]);
	expect(await gate.close()).toBe('proceed');
});

test('a raw file write that fails is rolled back and reported, and does not hold the close', async () => {
	const { gate, disk, notes, failures, edit } = await editing(RAW_PATH);
	disk.failWrites();
	expect(edit('{"kept": true}\n')).toBe(true);
	await quiet(notes);
	expect(failures).toMatchObject([{ path: RAW_PATH }]);
	// The text that did not land is offered to the person, not kept.
	expect(failures[0]?.lost).toBe('{"kept": true}\n');
	expect(disk.saved(RAW_PATH)).toBe(RAW);

	expect(await gate.close()).toBe('held');
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(gate.accepted('approve')).toEqual(['approve:1:1']);
	expect(gate.accepted('decline')).toEqual([]);
	expect(await gate.close()).toBe('proceed');
});

test('a rich-text edit that is still being written lands before the close is approved', async () => {
	const { gate, disk, notes, rich, failures } = await editingNote();
	disk.holdWrites();
	expect(rich.apply(rich.state.tr.insertText('rich ', 1))).toBeDefined();
	await until(() => disk.waitingWrites === 1, 'the write to start');
	expect(notes.saving).toBe(true);

	expect(await gate.close()).toBe('held');
	// A second close while the write runs starts no second answer.
	expect(await gate.close()).toBe('held');
	expect(gate.accepted('approve')).toEqual([]);
	// The fence is up while the write runs: an edit now is neither taken nor shown.
	expect(notes.fenced).toBe(true);
	const shown = rich.state;
	expect(rich.apply(rich.state.tr.insertText('late ', 1))).toBeUndefined();
	expect(rich.state).toBe(shown);

	disk.releaseWrites();
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(failures).toEqual([]);
	expect(gate.accepted('approve')).toEqual(['approve:1:1']);
	const saved = disk.saved(NOTE_PATH) as string;
	expect(disk.parse(saved).data?.body).toBe('rich body\n');
	// The whole note is saved as plain YAML: a value Honeycrisp does not
	// know is kept, and the comment is not.
	expect(saved).toContain('extra: 1\n');
	expect(saved).not.toContain('# kept');
	expect(await gate.close()).toBe('proceed');
});

test('a rich-text edit whose write fails is rolled back, reported with its text, and the close is approved', async () => {
	const { gate, disk, notes, note, rich, failures } = await editingNote();
	disk.failWrites();
	expect(rich.apply(rich.state.tr.insertText('mine ', 1))).toBeDefined();
	expect(undoDepth(rich.state)).toBe(1);
	await quiet(notes);
	expect(failures).toHaveLength(1);
	expect(failures[0]?.lost).toContain('mine body');
	// The cache took the file back; nothing was written.
	expect(note.row?.body).toBe('body\n');
	expect(disk.saved(NOTE_PATH)).toBe(NOTE);

	expect(await gate.close()).toBe('held');
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(gate.accepted('decline')).toEqual([]);
	expect(await gate.close()).toBe('proceed');
});

// ============================================================================
// Changes to files with no open editor
// ============================================================================

/** An open page over a fresh folder, with no file open. */
async function browsing() {
	const gate = shell();
	const disk = await folder();
	const { opening, problems } = page(async () => disk.host);
	const notes = await opening;
	return { gate, disk, notes, problems };
}

test.each([
	[
		'a new note',
		(notes: Awaited<ReturnType<typeof browsing>>['notes']) =>
			notes.createNote(),
	],
	[
		'a field change on a note that is not open',
		async (notes: Awaited<ReturnType<typeof browsing>>['notes']) =>
			notes.patchNote(NOTE_PATH, { title: 'Renamed' }),
	],
])('%s that is still being sent is waited for before the close is approved', async (_, change) => {
	const { gate, disk, notes } = await browsing();
	disk.holdWrites();
	const changing = change(notes);
	await until(() => disk.waitingWrites === 1, 'the change to be sent');
	expect(notes.busy).toBe(true);

	expect(await gate.close()).toBe('held');
	// The fence is up, and the approval waits for the change that was sent.
	await until(() => notes.fenced, 'the fence');
	expect(gate.accepted('approve')).toEqual([]);
	expect(disk.waitingWrites).toBe(1);

	disk.releaseWrites();
	expect(await changing).toBeUndefined();
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(gate.accepted('decline')).toEqual([]);
	expect(await gate.close()).toBe('proceed');
});

test('a new note whose reply is lost is reported once and does not hold the close', async () => {
	const { gate, disk, notes } = await browsing();
	disk.loseReplies();
	expect(await notes.createNote()).toContain('nothing confirmed it');
	expect(notes.busy).toBe(false);
	expect(await gate.close()).toBe('held');
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(await gate.close()).toBe('proceed');
});

test('a rename still reading its file when the close begins is never sent', async () => {
	const { gate, disk, notes } = await browsing();
	const pathsBefore = disk.paths();
	disk.holdReads();
	const renaming = notes.rename(RAW_PATH, 'renamed.json');
	await until(() => disk.waitingReads === 1, 'the read before the rename');
	// The literal paths were reserved before preparation, so close waits.
	expect(await gate.close()).toBe('held');
	await Promise.resolve();
	expect(gate.accepted('approve')).toEqual([]);
	disk.releaseReads();
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(await renaming).toContain('closing');
	expect(disk.moves).toBe(0);
	expect(disk.paths()).toEqual(pathsBefore);
});

// ============================================================================
// The input fence
// ============================================================================

/** The `invoke` Tauri's IPC mock installed, which the page's commands go through. */
function ipc() {
	return (
		globalThis as unknown as {
			__TAURI_INTERNALS__: {
				invoke(command: string, ...rest: unknown[]): Promise<unknown>;
			};
		}
	).__TAURI_INTERNALS__;
}

/**
 * Holds the page's `close_approve` on its way to the shell, as an IPC round
 * trip that takes time would. Every other command goes straight through.
 * Call after the gate's mock is installed.
 */
function delayApproval() {
	const internals = ipc();
	const invoke = internals.invoke;
	const sent = Promise.withResolvers<void>();
	const held = Promise.withResolvers<void>();
	const answered = Promise.withResolvers<void>();
	internals.invoke = async (command, ...rest) => {
		if (command !== 'close_approve') return invoke(command, ...rest);
		sent.resolve();
		await held.promise;
		try {
			return await invoke(command, ...rest);
		} finally {
			answered.resolve();
		}
	};
	return {
		/** The page sent its approval; the shell has not received it. */
		sent: sent.promise,
		/** Deliver the approval, and resolve once the gate answered it. */
		deliver() {
			held.resolve();
			return answered.promise;
		},
	};
}

/**
 * Fails the page's next `close_approve` with `cause` before it reaches the
 * shell: the page learns nothing about what the shell did.
 */
function failNextApproval(cause: unknown) {
	const internals = ipc();
	const invoke = internals.invoke;
	let failed = false;
	internals.invoke = async (command, ...rest) => {
		if (command !== 'close_approve' || failed) return invoke(command, ...rest);
		failed = true;
		throw cause;
	};
}

test('nothing is typed while an approval is on its way, so the close proceeds with every edit in its file', async () => {
	const { gate, disk, notes, edit } = await editing(RAW_PATH);
	expect(edit('{"typed before": true}\n')).toBe(true);
	const approval = delayApproval();
	expect(await gate.close()).toBe('held');
	// The edit was written, so the page approved.
	await approval.sent;
	expect(gate.accepted('approve')).toEqual([]);
	expect(disk.saved(RAW_PATH)).toBe('{"typed before": true}\n');

	// The approval has left the page and has not reached the shell.
	expect(notes.fenced).toBe(true);
	expect(edit('{"typed late": true}\n')).toBe(false);
	expect(await notes.createNote()).toContain('closing');
	expect(notes.busy).toBe(false);
	await approval.deliver();

	// The gate took the approval: the desktop shell exits here.
	expect(gate.accepted('approve')).toEqual(['approve:1:1']);
	expect(disk.saved(RAW_PATH)).toBe('{"typed before": true}\n');
	expect(notes.fenced).toBe(true);
});

test('an approval the shell refuses releases the fence, and the page says why', async () => {
	const { gate, notes, edit, problems } = await editing(RAW_PATH);
	const approval = delayApproval();
	expect(await gate.close()).toBe('held');
	await approval.sent;
	expect(notes.fenced).toBe(true);
	// The webview reloads before the approval arrives: it names an earlier page.
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('close_register');
	await approval.deliver();
	await until(() => problems.length === 1, 'the refused approval');
	expect(problems[0]).toBe('this page was replaced by a newer one');
	expect(gate.accepted('approve')).toEqual([]);
	expect(notes.fenced).toBe(false);
	expect(edit('{"still editing": true}\n')).toBe(true);
});

test('an approval the gate refuses because the request was already answered releases the fence', async () => {
	const { gate, notes, edit, problems } = await editing(RAW_PATH);
	const approval = delayApproval();
	expect(await gate.close()).toBe('held');
	await approval.sent;
	// The request is declined before the approval arrives.
	const { invoke } = await import('@tauri-apps/api/core');
	await invoke('close_decline', { generation: 1, request: 1 });
	await approval.deliver();
	await until(() => problems.length === 1, 'the refused approval');
	expect(problems[0]).toBe(
		'this close request is no longer waiting for an answer',
	);
	expect(gate.accepted('approve')).toEqual([]);
	expect(notes.fenced).toBe(false);
	expect(edit('{"still editing": true}\n')).toBe(true);
});

test('"the app is already closing" keeps the fence: it is a refusal, and the app is going', async () => {
	const { gate, notes, edit, problems } = await editing(RAW_PATH);
	const held = Promise.withResolvers<void>();
	const sent = Promise.withResolvers<void>();
	const internals = ipc();
	const invoke = internals.invoke;
	let first = true;
	internals.invoke = async (command, ...rest) => {
		if (command !== 'close_approve' || !first) return invoke(command, ...rest);
		first = false;
		sent.resolve();
		await held.promise;
		return invoke(command, ...rest);
	};
	expect(await gate.close()).toBe('held');
	await sent.promise;
	// The gate takes an approval of this request by another route first.
	const tauri = await import('@tauri-apps/api/core');
	await tauri.invoke('close_approve', { generation: 1, request: 1 });
	held.resolve();
	await until(() => problems.length === 1, 'the refused approval');
	expect(problems[0]).toBe('the app is already closing');
	expect(notes.fenced).toBe(true);
	expect(edit('{"typed late": true}\n')).toBe(false);
	expect(await gate.close()).toBe('proceed');
});

test.each([
	['an Error', new Error('the webview lost its IPC connection')],
	['other text', 'close_approve not allowed'],
	['a number', 503],
	['nothing', undefined],
])('an approval that fails with %s keeps the fence, and the next close is answered again', async (_, cause) => {
	const { gate, notes, edit, problems } = await editing(RAW_PATH);
	failNextApproval(cause);
	expect(await gate.close()).toBe('held');
	await until(() => problems.length === 1, 'the failed approval');
	expect(problems[0]).toBe(cause);
	// Whether the shell took it is unknown, so nothing may be typed.
	expect(gate.accepted('approve')).toEqual([]);
	expect(notes.fenced).toBe(true);
	expect(edit('{"typed late": true}\n')).toBe(false);
	// The shell did not take it: the same request is asked again and answered.
	expect(await gate.close()).toBe('held');
	await until(() => gate.accepted('approve').length === 1, 'the approval');
	expect(gate.accepted('approve')).toEqual(['approve:1:1']);
	expect(await gate.close()).toBe('proceed');
});

// ============================================================================
// No replay
// ============================================================================

/** A held page that records each request instead of answering it. */
async function holding() {
	const problems: unknown[] = [];
	const requests: CloseRequest[] = [];
	const closing = await registerPage((cause) => problems.push(cause));
	const answers: PromiseWithResolvers<void>[] = [];
	await closing.hold((request) => {
		requests.push(request);
		const answer = Promise.withResolvers<void>();
		answers.push(answer);
		return answer.promise;
	});
	return { requests, answers, problems };
}

test('an answer is final: a declined request cannot approve, and an approved one is sent once', async () => {
	const gate = shell();
	const { requests, answers } = await holding();
	expect(await gate.close()).toBe('held');
	const [first] = requests;
	await first?.decline();
	await first?.approve();
	await first?.decline();
	answers[0]?.resolve();
	expect(gate.steps.slice(3)).toEqual(['decline:1:1']);
	// The gate itself refuses the declined request, whoever sends it.
	const { invoke } = await import('@tauri-apps/api/core');
	await expect(
		invoke('close_approve', { generation: 1, request: 1 }),
	).rejects.toBe('this close request is no longer waiting for an answer');
	expect(await gate.close()).toBe('held');
	await requests[1]?.approve();
	await requests[1]?.approve();
	// One approval reached the gate, and the gate accepted exactly that one.
	expect(gate.steps.filter((step) => step === 'approve:1:2')).toHaveLength(1);
	expect(gate.accepted('approve')).toEqual(['approve:1:2']);
	expect(await gate.close()).toBe('proceed');
});

test('closes that arrive while one is being answered do not start another answer', async () => {
	const gate = shell();
	const { requests } = await holding();
	for (let attempt = 0; attempt < 5; attempt += 1)
		expect(await gate.close()).toBe('held');
	expect(requests).toHaveLength(1);
	expect(gate.accepted('approve')).toEqual([]);
});

test('an approval sent across a reload cannot approve for the page that replaced it', async () => {
	const { gate, problems } = await editing(RAW_PATH);
	const approval = delayApproval();
	expect(await gate.close()).toBe('held');
	await approval.sent;

	// The webview reloads: the earlier page stops listening and a new one starts.
	gate.dropPage();
	const reloaded = await holding();
	await approval.deliver();
	await until(() => problems.length === 1, 'the refused approval');
	expect(problems[0]).toBe('this page was replaced by a newer one');

	// The new page is asked a request of its own, and only its answer counts.
	expect(await gate.close()).toBe('held');
	expect(reloaded.requests).toHaveLength(1);
	expect(await gate.close()).toBe('held');
	await reloaded.requests[0]?.approve();
	expect(gate.accepted('approve')).toEqual(['approve:2:2']);
	expect(await gate.close()).toBe('proceed');
});

test('a page that stopped answering is asked again on every close and never bypassed', async () => {
	const { gate } = await editing(RAW_PATH);
	// Its process died, or its listener is gone: nothing answers.
	gate.dropPage();
	for (let attempt = 0; attempt < 5; attempt += 1)
		expect(await gate.close()).toBe('held');
	expect(gate.accepted('approve')).toEqual([]);
	expect(gate.accepted('decline')).toEqual([]);
});
