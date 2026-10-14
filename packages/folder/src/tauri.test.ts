/**
 * Tauri Folder Adapter Tests
 *
 * `openFolder` from the desktop entry turns the native folder owner's commands
 * into the same folder handle the browser opener returns. These tests script
 * the shell's replies to pin what the adapter itself decides: what an
 * unanswered command means, when a guarded save may look again, and what
 * closing does.
 *
 * Key behaviors:
 * - Outside the shell, opening is refused and nothing is invoked; a refusal
 *   inside the shell never opens browser storage
 * - A save's capture comes from the bytes that were sent, not from a read
 * - Each save is one `apply` of one change; an owner's partial move is
 *   `SourceNotRemoved`, and any other partial report is `Unconfirmed`
 * - Saves carry no number and nothing orders them: a save still hashing or
 *   reading is sent after a later one, through any handle; one not yet sent
 *   when the folder closes sends nothing
 * - A lost reply to a save is `Unconfirmed` and is never sent again; a lost
 *   reply to a read is an ordinary failure
 * - An outcome the owner could not confirm stays `Unconfirmed` here
 * - A page built for another protocol version is refused at attach
 * - A commit replies with its outcome alone, and a push names no pass to join
 * - Closing during a commit starts no push afterward
 * - Snapshot events replace the snapshot in order; a stale one is dropped
 * - A merge is one `merge_incoming` with its unrelated-history consent and
 *   whether it wants conflict versions; its outcomes, refusals (a conflict
 *   among them), and the snapshot's last attempt arrive in the shared
 *   shapes, conflict versions as `Uint8Array`, and a lost reply is
 *   `Unconfirmed`
 * - Closing detaches this window once and does not shut the folder down
 *
 * See also:
 * - `tauri-native.test.ts` for the same adapter against the real Rust owner
 */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
} from './browser-storage.test-support.js';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import type { RecordedIncoming } from './git/backend.js';
import { formatRow } from './row-text.js';

type Call = { cmd: string; args: Record<string, unknown> };
type Reply = (call: Call) => unknown;

let inShell = true;
let calls: Call[] = [];
/** Replies by command. A function that throws an `Error` loses the reply. */
let replies: Record<string, Reply> = {};
let failedListener: string | undefined;
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

const refuse = (error: unknown): never => {
	// A Rust `Err` rejects with the error value itself, not an `Error`.
	throw error;
};

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(cmd: string, args: Record<string, unknown> = {}) {
		const name = cmd.replace('plugin:epicenter-folder|', '');
		// The shell's owner opens every folder these tests open: the grant
		// that comes first is refused, and is not part of what they record.
		if (name === 'grant_directory' && replies[name] === undefined)
			refuse({ name: 'UsesOwner', scope: args.scope });
		calls.push({ cmd: name, args });
		const reply = replies[name];
		if (reply === undefined) throw new Error(`no scripted reply for ${name}`);
		return reply({ cmd: name, args });
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	async listen(name: string, callback: (event: { payload: unknown }) => void) {
		if (failedListener !== undefined && name.endsWith(failedListener))
			throw new Error('event.listen not allowed');
		const set = listeners.get(name) ?? new Set();
		listeners.set(name, set);
		set.add(callback);
		return () => set.delete(callback);
	},
}));

const { openFolder } = await import('./tauri.js');

const definition = defineFolder({
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const wireSnapshot = (overrides: Record<string, unknown> = {}) => ({
	branch: 'main',
	remote: null,
	files: { state: 'unknown', error: null },
	sync: { state: 'unknown', error: null },
	activity: Object.fromEntries(
		['scan', 'commit', 'push', 'fetch', 'pull', 'merge'].map((name) => [
			name,
			{ active: false },
		]),
	),
	lastCommit: null,
	lastPush: null,
	lastFetch: null,
	lastPull: null,
	lastMerge: null,
	pendingIncoming: null,
	closed: false,
	...overrides,
});

function emit(name: string, payload: unknown) {
	for (const listener of listeners.get(`plugin:epicenter-folder:${name}`) ?? [])
		listener({ payload });
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);

/** Wait until the adapter has sent `count` of a command. */
async function untilSent(cmd: string, count = 1) {
	while (sent(cmd).length < count) await Bun.sleep(0);
}

/** The number the scripted owner gives the first request a test opens. */
const FIRST_REQUEST = 100;

async function attached() {
	let nextRequest = FIRST_REQUEST;
	replies = {
		attach: () => ({
			session: 7,
			root: '/Users/someone/Epicenter/notes',
			sequence: 3,
			snapshot: wireSnapshot(),
		}),
		detach: () => null,
		apply: () => null,
		open_request: () => nextRequest++,
		withdraw_request: () => null,
	};
	const folder = expectOk(await openFolder({ id: 'notes', definition }));
	expect(sent('attach')[0]?.args).toEqual({ scope: 'notes', protocol: 9 });
	expect(folder.location).toEqual({
		kind: 'directory',
		root: '/Users/someone/Epicenter/notes',
	});
	// A handle's first write publishes its declaration first; these tests
	// are about the writes after it.
	expectOk(await folder.files.create('first.md', 'first'));
	calls = [];
	return folder;
}

afterEach(() => {
	inShell = true;
	calls = [];
	replies = {};
	failedListener = undefined;
	listeners.clear();
});

test('the folder opened is the scope the opener names', async () => {
	replies = {
		attach: () => ({
			session: 7,
			root: '/Users/someone/Epicenter/notes',
			sequence: 3,
			snapshot: wireSnapshot(),
		}),
		detach: () => null,
		apply: () => null,
	};
	const folder = expectOk(
		await openFolder({
			id: 'so.epicenter.taurifoldertest',
			definition,
			// Browser settings do not reach the shell: its own author is in effect.
			browser: {
				author: { name: 'Browser', email: 'browser@example.test' },
			},
		}),
	);
	expect(sent('attach')[0]?.args).toEqual({
		scope: 'so.epicenter.taurifoldertest',
		protocol: 9,
	});
	expect(folder.git.snapshot.remote).toBeUndefined();
	await folder.close();
});

test('a refusal inside the shell is returned; browser storage is never opened instead', async () => {
	const storage = createTestStorage();
	for (const refusal of [
		{ name: 'UnknownScope', scope: 'notes' },
		{ name: 'WindowNotPermitted', scope: 'notes', window: 'main' },
		'plugin epicenter-folder not found',
	]) {
		replies = { attach: () => refuse(refusal) };
		const refused = expectErr(
			await openFolder({
				id: 'notes',
				definition,
				browser: browserStorage(storage),
			}),
		);
		expect<string>(refused.name).toBe(
			typeof refusal === 'string' ? 'Unavailable' : refusal.name,
		);
	}
	expect(storage.opfs.directories()).toEqual([]);
});

test('outside the desktop shell, opening is refused and nothing is invoked', async () => {
	inShell = false;

	const refused = expectErr(await openFolder({ id: 'notes', definition }));

	expect(refused.name).toBe('NotTauri');
	expect(calls).toEqual([]);
});

test('an attach the shell refuses is returned with its reason and leaves no listener', async () => {
	replies = {
		attach: () =>
			refuse({ name: 'Busy', root: '/Users/someone/Epicenter/notes' }),
	};

	const refused = expectErr(await openFolder({ id: 'notes', definition }));

	expect(refused.name).toBe('Busy');
	expect(refused.message).toContain('/Users/someone/Epicenter/notes');
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test('a bare-string attach rejection preserves its cause and leaves no listeners', async () => {
	const reason = 'epicenter-folder.attach not allowed';
	replies.attach = () => refuse(reason);
	const error = expectErr(await openFolder({ id: 'notes', definition }));
	expect(error.name).toBe('Unavailable');
	expect(error.message).toContain(reason);
	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test.each([
	'folder-snapshot-changed',
	'folder-files-changed',
])('a failed %s listener leaves no listener and never attaches', async (event) => {
	failedListener = event;
	const error = expectErr(await openFolder({ id: 'notes', definition }));
	expect(error.name).toBe('Unavailable');
	expect(error.message).toContain('event.listen not allowed');
	expect(calls).toEqual([]);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test('a desktop app that speaks another protocol is refused at attach, before any other call', async () => {
	calls = [];
	replies = {
		// A desktop app from before it merged.
		attach: () => refuse({ name: 'Incompatible', host: 8, page: 9 }),
	};
	const refused = expectErr(await openFolder({ id: 'notes', definition }));
	expect(refused).toMatchObject({ name: 'Incompatible', host: 8, page: 9 });
	expect(refused.message).toContain('Update the app');
	expect(calls).toEqual([
		{ cmd: 'attach', args: { scope: 'notes', protocol: 9 } },
	]);
});

test('a save whose reply is lost is Unconfirmed and is sent exactly once', async () => {
	const folder = await attached();
	replies.apply = () => {
		throw new Error('the webview lost its IPC connection');
	};

	const lost = expectErr(await folder.files.create('notes/a.md', 'text'));

	expect(lost.name).toBe('Unconfirmed');
	expect(lost.message).toContain('may have completed');
	expect(sent('apply')).toHaveLength(1);
	expect(sent('apply')[0]?.args).toEqual({
		session: 7,
		changes: [
			{ kind: 'create', path: 'notes/a.md', bytes: [116, 101, 120, 116] },
		],
	});
});

test('a read whose reply is lost is an ordinary failure, and Git changes are Unconfirmed', async () => {
	const folder = await attached();
	const lose = () => {
		throw new Error('connection lost');
	};
	replies = {
		...replies,
		read: lose,
		commit: lose,
		push: lose,
		stage: lose,
		status: lose,
	};

	expect(expectErr(await folder.files.read('a.md')).name).toBe('Io');
	expect(expectErr(await folder.git.status()).name).toBe('Failed');
	expect(await folder.git.commit()).toEqual({
		status: 'unconfirmed',
		error: 'connection lost',
	});
	expect(await folder.git.push()).toEqual({
		status: 'unconfirmed',
		error: 'connection lost',
	});
	expect(expectErr(await folder.git.stage('all')).name).toBe('Unconfirmed');
	for (const cmd of ['read', 'commit', 'push', 'stage', 'status'])
		expect(sent(cmd)).toHaveLength(1);
});

test('a primitive rejection of a change remains Unconfirmed and is not retried', async () => {
	const folder = await attached();
	const reason = 'epicenter-folder.apply not allowed';
	replies.apply = () => refuse(reason);
	const error = expectErr(await folder.files.create('a.md', 'new'));
	expect(error.name).toBe('Unconfirmed');
	expect(error.message).toContain(reason);
	expect(sent('apply')).toHaveLength(1);
	await folder.close();
});

test('typed refusals from the owner become the shared file errors', async () => {
	const folder = await attached();
	const sha256 = 'a'.repeat(64);
	replies.apply = () =>
		refuse({
			name: 'Refused',
			error: {
				name: 'Conflict',
				path: 'a.md',
				expectedSha256: sha256,
				actualSha256: null,
			},
		});

	const conflict = expectErr(
		await folder.files.replace({ path: 'a.md', sha256 }, 'next'),
	);

	expect(conflict.name).toBe('Conflict');
	if (conflict.name !== 'Conflict') return;
	expect(conflict.expectedSha256).toEqual(sha256);
	expect(conflict.actualSha256).toBeUndefined();
	expect(conflict.message).toBe(
		"No file exists at 'a.md' to match the captured SHA-256",
	);

	replies.apply = () =>
		refuse({
			name: 'Partial',
			applied: [{ kind: 'write', path: 'b.md' }],
			failed: { kind: 'remove', path: 'a.md' },
			error: { name: 'Io', path: 'a.md', operation: 'retire', cause: 'busy' },
			notAttempted: [],
		});
	const kept = expectErr(
		await folder.files.move({ path: 'a.md', sha256 }, 'b.md'),
	);
	expect(kept.name).toBe('SourceNotRemoved');
	if (kept.name !== 'SourceNotRemoved') return;
	expect(kept).toMatchObject({
		from: 'a.md',
		to: 'b.md',
		moved: { path: 'b.md', sha256 },
	});
	expect(kept.cause.message).toBe("Could not retire 'a.md': busy");
});

test('a save unanswered while a later one lands takes its own reply; no save carries a number', async () => {
	const folder = await attached();
	const unanswered = Promise.withResolvers<null>();
	let asked = 0;
	replies.apply = () => (asked++ === 0 ? unanswered.promise : null);

	// The first save is still unanswered when the second is asked for and lands.
	const first = folder.files.overwrite('a.md', 'first');
	expectOk(await folder.files.overwrite('a.md', 'second'));
	unanswered.resolve(null);
	expectOk(await first);
	for (const call of sent('apply'))
		expect(Object.keys(call.args).sort()).toEqual(['changes', 'session']);
	replies.mkdir = () => null;
	expectOk(await folder.files.mkdir('dir'));
	expect(sent('mkdir')[0]?.args).toEqual({ session: 7, path: 'dir' });
});

/**
 * Hold the next SHA-256 digest anyone asks for until `release`, where a slow
 * hash would leave a save. Digests after it run at once.
 */
function holdNextDigest() {
	const digest = crypto.subtle.digest.bind(crypto.subtle);
	const reached = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	let holding = true;
	const spy = spyOn(crypto.subtle, 'digest').mockImplementation(
		async (algorithm, data) => {
			if (holding) {
				holding = false;
				reached.resolve();
				await released.promise;
			}
			return digest(algorithm, data);
		},
	);
	spies.push(() => spy.mockRestore());
	return { reached: reached.promise, release: () => released.resolve() };
}
const spies: (() => void)[] = [];
afterEach(() => {
	for (const restore of spies.splice(0)) restore();
});

/** The text of each apply sent, in the order it was sent. */
const applies = () =>
	sent('apply').map((call) =>
		new TextDecoder().decode(
			Uint8Array.from(
				(call.args.changes as { bytes: number[] }[])[0]?.bytes ?? [],
			),
		),
	);

test('a save still hashing is sent after a later one; nothing orders them', async () => {
	const folder = await attached();
	replies.apply = () => null;
	const digest = holdNextDigest();

	const earlier = folder.files.overwrite('note.md', 'earlier');
	await digest.reached;
	expectOk(await folder.files.overwrite('note.md', 'later'));
	digest.release();
	expectOk(await earlier);

	// The owner lands whichever reaches it last.
	expect(applies()).toEqual(['later', 'earlier']);
});

test('a table replace still hashing is sent after a raw save made meanwhile', async () => {
	const folder = await attached();
	const row = new TextEncoder().encode('---\ntitle: Take\ndone: false\n---\n');
	replies.read = () => ({ bytes: [...row], sha256: 'a'.repeat(64) });
	replies.apply = () => null;
	const stored = expectOk(await folder.tables.todos.get('take'));
	if (stored === undefined) throw new Error('the row is missing');
	const digest = holdNextDigest();

	const taken = { fields: { title: 'Taken', done: false }, body: '' };
	const edited = expectOk(formatRow(definition.tables.todos, taken));
	const replacing = folder.tables.todos.replace(stored, taken);
	await digest.reached;
	expectOk(await folder.files.overwrite('todos/take.md', 'raw'));
	digest.release();
	expectOk(await replacing);

	expect(applies()).toEqual(['raw', edited]);
	// An existing-row replacement, never an overwrite.
	expect(
		(sent('apply')[1]?.args.changes as { kind: string }[] | undefined)?.[0]
			?.kind,
	).toBe('replace');
});

test("two handles of one page send independently: one's held save is sent after the other's later one", async () => {
	const one = await attached();
	const other = await attached();
	replies.apply = () => null;
	const digest = holdNextDigest();

	const earlier = one.files.overwrite('note.md', 'earlier');
	await digest.reached;
	expectOk(await other.files.overwrite('note.md', 'later'));
	digest.release();
	expectOk(await earlier);

	expect(applies()).toEqual(['later', 'earlier']);
});

test('a save still hashing when the folder closes sends nothing', async () => {
	const folder = await attached();
	replies.apply = () => null;
	const digest = holdNextDigest();

	const saving = folder.files.overwrite('note.md', 'too late');
	await digest.reached;
	await folder.close();
	digest.release();

	expect(expectErr(await saving).name).toBe('Closed');
	expect(sent('apply')).toEqual([]);
});

test('an outcome the owner itself could not confirm is Unconfirmed, not a refusal', async () => {
	const folder = await attached();
	const unknown = {
		name: 'Unconfirmed',
		path: 'a.md',
		operation: 'publishing to',
		cause: 'the worker stopped',
	};
	replies.apply = () => refuse(unknown);
	replies.commit = () => ({
		status: 'unconfirmed',
		error: 'the worker stopped',
	});
	replies.fetch = () =>
		refuse({
			name: 'Unconfirmed',
			operation: 'fetch',
			cause: 'the worker stopped',
		});

	const save = expectErr(await folder.files.overwrite('a.md', 'text'));

	expect(save.name).toBe('Unconfirmed');
	expect(save.message).toContain('may have completed');
	expect(await folder.git.commit()).toEqual({
		status: 'unconfirmed',
		error: 'the worker stopped',
	});
	expect(expectErr(await folder.git.fetch()).name).toBe('Unconfirmed');
	expect(sent('apply')).toHaveLength(1);
});

test("a table save changes exactly its row file, under that file's exact condition", async () => {
	const folder = await attached();
	// Audio already shares the stem. It is not asked about and not sent.
	replies.children = () => ({ files: ['take.png'], directories: [] });
	replies.apply = () => null;

	const created = expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Take', done: false }, body: '' },
			{ stem: 'take' },
		),
	);

	expect(sent('apply')).toHaveLength(1);
	const { changes, ...rest } = sent('apply')[0]?.args as {
		changes: { kind: string; path: string; expectedSha256?: string }[];
	};
	expect(rest).toEqual({ session: 7 });
	expect(changes.map(({ kind, path }) => ({ kind, path }))).toEqual([
		{ kind: 'create', path: 'todos/take.md' },
	]);

	calls = [];
	// Every later change is guarded by the bytes the capture names: a
	// replacement is never sent as an overwrite.
	expectOk(await folder.tables.todos.rename(created, 'next'));
	expectOk(await folder.tables.todos.delete(created));
	const taken = { fields: { title: 'Taken', done: false }, body: '' };
	expectOk(await folder.tables.todos.replace(created, taken));
	// A guarded change publishes; it reads no row back.
	expect(calls.some((call) => call.cmd === 'read')).toBe(false);
	expect(sent('apply').map((call) => call.args.changes)).toEqual([
		[
			{
				kind: 'move',
				from: 'todos/take.md',
				to: 'todos/next.md',
				expectedSha256: created.sha256,
			},
		],
		[{ kind: 'remove', path: 'todos/take.md', expectedSha256: created.sha256 }],
		[
			{
				kind: 'replace',
				path: 'todos/take.md',
				bytes: Array.from(
					new TextEncoder().encode(
						expectOk(formatRow(definition.tables.todos, taken)),
					),
				),
				expectedSha256: created.sha256,
			},
		],
	]);
});

test('a save returns the capture of the bytes it sent, without reading them back', async () => {
	const folder = await attached();
	replies.apply = () => null;
	const sentVersion = await hashBytes(new TextEncoder().encode('mine'));

	const created = expectOk(await folder.files.create('a.md', 'mine'));
	const moved = expectOk(await folder.files.move(created, 'b.md'));

	// The owner was asked to publish and nothing else: no read followed.
	expect(calls.map((call) => call.cmd)).toEqual(['apply', 'apply']);
	expect(created).toEqual({ path: 'a.md', sha256: sentVersion });
	expect(moved).toEqual({ path: 'b.md', sha256: sentVersion });

	// Another writer replaced the file right after the save was acknowledged.
	// Reading is a new observation; the save's capture is still what was saved.
	const raced = new TextEncoder().encode('someone else');
	replies.read = () => ({
		bytes: [...raced],
		sha256: 'e'.repeat(64),
	});
	const observed = expectOk(await folder.files.read('b.md'));
	expect(observed.sha256).toEqual('e'.repeat(64));
	expect(moved.sha256).toEqual(sentVersion);
	expect(Object.isFrozen(moved)).toBe(true);
});

test('a replace is one apply carrying its bytes and captured hash, and returns a capture of what was sent', async () => {
	const folder = await attached();
	replies.apply = () => null;
	const audio = new Uint8Array([1, 2, 3]);
	const observed = { path: 'audio/old.webm', sha256: 'a'.repeat(64) };

	const replaced = expectOk(await folder.files.replace(observed, audio));

	expect(calls).toEqual([
		{
			cmd: 'apply',
			args: {
				session: 7,
				changes: [
					{
						kind: 'replace',
						path: 'audio/old.webm',
						bytes: [1, 2, 3],
						expectedSha256: observed.sha256,
					},
				],
			},
		},
	]);
	expect(replaced).toEqual({
		path: 'audio/old.webm',
		sha256: await hashBytes(audio),
	});
});

test('a partial report that is not a move keeping its source is Unconfirmed, never a receipt', async () => {
	const folder = await attached();
	replies.children = () => ({ files: [], directories: [] });
	const report = {
		name: 'Partial',
		applied: [{ kind: 'write', path: 'todos/take.md' }],
		failed: { kind: 'write', path: 'todos/other.md' },
		error: {
			name: 'Io',
			path: 'todos/other.md',
			operation: 'create',
			cause: 'disk full',
		},
		notAttempted: [],
	};
	replies.apply = () => refuse(report);
	const created = expectErr(
		await folder.tables.todos.create(
			{ fields: { title: 'Take', done: false }, body: '' },
			{ stem: 'take' },
		),
	);
	expect(created).toMatchObject({
		name: 'Unconfirmed',
		path: 'todos/take.md',
		cause: { name: 'Partial', applied: report.applied },
	});
	// Sent once; nothing here decides to send it again.
	expect(sent('apply')).toHaveLength(1);
});

test('snapshot events replace the snapshot in order and a stale one is dropped', async () => {
	const folder = await attached();
	const heard: (string | undefined)[] = [];
	folder.git.subscribe((snapshot) => heard.push(snapshot.lastCommit?.status));
	const committed = (sequence: number, oid: string) =>
		emit('folder-snapshot-changed', {
			scope: 'notes',
			sequence,
			snapshot: wireSnapshot({
				lastCommit: {
					at: 1,
					result: {
						status: 'committed',
						oid,
						parent: null,
						message: 'Add a.md',
						changedPaths: 1,
						indexWarning: null,
					},
				},
			}),
		});

	committed(3, 'stale: the attach reply already carried sequence 3');
	committed(5, 'five');
	committed(4, 'late');
	emit('folder-snapshot-changed', {
		scope: 'another-scope',
		sequence: 9,
		snapshot: wireSnapshot(),
	});

	expect(heard).toEqual([undefined, 'committed']);
	expect(folder.git.snapshot.lastCommit).toEqual({
		status: 'committed',
		oid: 'five',
		parent: undefined,
		message: 'Add a.md',
		changedPaths: 1,
		indexWarning: undefined,
		at: 1,
	});
	expect(folder.git.snapshot.remote).toBeUndefined();
});

test('file change events reach listeners until they stop listening', async () => {
	const folder = await attached();
	const heard: (readonly string[])[] = [];
	const stop = folder.onFilesChanged((paths) => heard.push(paths));

	emit('folder-files-changed', {
		scope: 'notes',
		revision: 1,
		paths: ['a.md'],
	});
	emit('folder-files-changed', {
		scope: 'other',
		revision: 2,
		paths: ['b.md'],
	});
	stop();
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 3,
		paths: ['c.md'],
	});

	expect(heard).toEqual([['a.md']]);
});

test("this page's own saves are announced without the owner's event; a definite refusal is not", async () => {
	// The owner's change event is best effort. This scripted owner sends none.
	const folder = await attached();
	const heard: (readonly string[])[] = [];
	folder.onFilesChanged(() => {
		throw new Error('broken listener');
	});
	folder.onFilesChanged((paths) => heard.push(paths));
	const sha256 = 'a'.repeat(64);

	replies.apply = () => null;
	expectOk(await folder.files.create('a.md', 'text'));
	expectOk(await folder.files.move({ path: 'a.md', sha256 }, 'b.md'));
	expect(heard).toEqual([['a.md'], ['a.md', 'b.md']]);

	heard.length = 0;
	replies.apply = () =>
		refuse({
			name: 'Refused',
			error: {
				name: 'Conflict',
				path: 'a.md',
				expectedSha256: sha256,
				actualSha256: null,
			},
		});
	expect(
		expectErr(await folder.files.replace({ path: 'a.md', sha256 }, 'next'))
			.name,
	).toBe('Conflict');
	expect(heard).toEqual([]);

	// A lost reply or one the owner could not confirm may have changed the
	// file: listeners are asked to reread, and the save stays Unconfirmed and
	// is sent once.
	replies.apply = () => {
		throw new Error('the webview lost its IPC connection');
	};
	expect(expectErr(await folder.files.overwrite('c.md', 'lost')).name).toBe(
		'Unconfirmed',
	);
	replies.apply = () =>
		refuse({
			name: 'Unconfirmed',
			path: 'd.md',
			operation: 'publishing to',
			cause: 'the worker stopped',
		});
	expect(expectErr(await folder.files.overwrite('d.md', 'late')).name).toBe(
		'Unconfirmed',
	);
	expect(heard).toEqual([['c.md'], ['d.md']]);
	expect(sent('apply')).toHaveLength(5);

	// A partial report names what landed, and keeps its exact outcome.
	heard.length = 0;
	const report = {
		name: 'Partial',
		applied: [{ kind: 'write', path: 'b.md' }],
		failed: { kind: 'remove', path: 'a.md' },
		error: { name: 'Io', path: 'a.md', operation: 'retire', cause: 'busy' },
		notAttempted: [],
	};
	replies.apply = () => refuse(report);
	const kept = expectErr(
		await folder.files.move({ path: 'a.md', sha256 }, 'b.md'),
	);
	expect(kept).toMatchObject({ name: 'SourceNotRemoved', from: 'a.md' });
	expect(heard).toEqual([['b.md']]);

	// After closing, nothing is announced to the listeners it dropped.
	await folder.close();
	heard.length = 0;
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 1,
		paths: ['e.md'],
	});
	expect(heard).toEqual([]);
});

test('an observer that throws on an owner event silences no other observer, and closing from one fences the rest', async () => {
	const folder = await attached();
	const files: string[] = [];
	const branches: string[] = [];
	folder.onFilesChanged(() => {
		throw new Error('broken listener');
	});
	folder.onFilesChanged((paths) => files.push(...paths));
	let throwing = false;
	folder.git.subscribe(() => {
		if (throwing) throw new Error('broken subscriber');
	});
	folder.git.subscribe((snapshot) => branches.push(snapshot.branch));
	throwing = true;

	emit('folder-files-changed', {
		scope: 'notes',
		revision: 1,
		paths: ['a.md'],
	});
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 4,
		snapshot: wireSnapshot({ branch: 'next' }),
	});
	expect(files).toEqual(['a.md']);
	expect(branches).toEqual(['main', 'next']);
	// The adapter's own state moved on as well: the throw cost it nothing.
	expect(folder.git.snapshot.branch).toBe('next');

	// A listener that closes the folder: the one after it is not called, in
	// this dispatch or any later one.
	let closing: Promise<void> | undefined;
	folder.onFilesChanged(() => {
		closing = folder.close();
	});
	const late: string[] = [];
	folder.onFilesChanged((paths) => late.push(...paths));
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 2,
		paths: ['b.md'],
	});
	await closing;
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 3,
		paths: ['c.md'],
	});
	expect(files).toEqual(['a.md', 'b.md']);
	expect(late).toEqual([]);
	expect(sent('detach')).toHaveLength(1);
});

/** A reply the test settles later, to hold a command in flight. */
function held<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { reply: () => promise, settle: resolve };
}

/** The commit command's reply: the settled outcome itself. */
const committed = {
	status: 'committed',
	oid: 'c'.repeat(40),
	parent: null,
	message: 'Add a.md',
	changedPaths: 1,
	indexWarning: null,
};

// ============================================================================
// A pending incoming update (ADR-0474)
// ============================================================================

const RECORD = {
	state: 'recorded',
	operationId: 'op-1',
	branch: 'main',
	expectedHead: null,
	nextHead: 'b'.repeat(40),
} as const;
const RECORDED: RecordedIncoming = {
	state: 'recorded',
	operationId: 'op-1',
	branch: 'main',
	expectedHead: undefined,
	nextHead: 'b'.repeat(40),
};

test('a pending incoming update appears in the snapshot, and is absent where there is none', async () => {
	const folder = await attached();
	expect('pendingIncoming' in folder.git.snapshot).toBe(false);
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 4,
		snapshot: wireSnapshot({ pendingIncoming: RECORD }),
	});
	expect(folder.git.snapshot.pendingIncoming).toEqual(RECORDED);
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 5,
		snapshot: wireSnapshot({
			pendingIncoming: {
				state: 'unreadable',
				reason: 'the incoming record is empty',
			},
		}),
	});
	expect(folder.git.snapshot.pendingIncoming).toEqual({
		state: 'unreadable',
		reason: 'the incoming record is empty',
	});
});

test('recovery is sent only when asked, and each settled outcome names its record', async () => {
	const folder = await attached();
	expect(sent('recover_incoming')).toEqual([]);

	replies.recover_incoming = () => ({ status: 'none' });
	expect(expectOk(await folder.git.recoverIncoming())).toEqual({
		status: 'none',
	});
	replies.recover_incoming = () => ({ status: 'cleared', pending: RECORD });
	expect(expectOk(await folder.git.recoverIncoming())).toEqual({
		status: 'cleared',
		pending: RECORDED,
	});
	replies.recover_incoming = () => ({
		status: 'completed',
		pending: RECORD,
		changedPaths: ['a.md'],
	});
	expect(expectOk(await folder.git.recoverIncoming())).toEqual({
		status: 'completed',
		pending: RECORDED,
		changedPaths: ['a.md'],
	});
	expect(sent('recover_incoming')).toEqual(
		Array.from({ length: 3 }, () => ({
			cmd: 'recover_incoming',
			args: { session: 7 },
		})),
	);
});

test('a refused, partial, or unanswered recovery keeps the update unknown or pending, and is not retried', async () => {
	const folder = await attached();
	replies.recover_incoming = () =>
		refuse({
			name: 'RecoveryRefused',
			pending: RECORD,
			paths: ['a.md'],
			reason: 'a.md holds bytes in neither state',
		});
	expect(expectErr(await folder.git.recoverIncoming())).toMatchObject({
		name: 'RecoveryRefused',
		pending: RECORDED,
		paths: ['a.md'],
	});

	replies.recover_incoming = () =>
		refuse({
			name: 'Unconfirmed',
			applied: [{ kind: 'write', path: 'a.md' }],
			uncertain: ['.git/refs/heads/main'],
			error: 'update-ref did not finish',
		});
	expect(expectErr(await folder.git.recoverIncoming())).toMatchObject({
		name: 'Unconfirmed',
		applied: [{ kind: 'write', path: 'a.md' }],
		uncertain: ['.git/refs/heads/main'],
	});

	calls = [];
	replies.recover_incoming = () => {
		throw new Error('the webview lost its IPC connection');
	};
	expect(expectErr(await folder.git.recoverIncoming()).name).toBe(
		'Unconfirmed',
	);
	expect(sent('recover_incoming')).toHaveLength(1);
});

test('history work a pending update holds back is refused with the record that holds it', async () => {
	const folder = await attached();
	replies.pull_fast_forward = () =>
		refuse({ name: 'IncomingPending', pending: RECORD });
	expect(expectErr(await folder.git.pullFastForward())).toMatchObject({
		name: 'IncomingPending',
		pending: RECORDED,
	});
	replies.stage = () => refuse({ name: 'IncomingPending', pending: RECORD });
	expect(expectErr(await folder.git.stage('all'))).toMatchObject({
		name: 'IncomingPending',
		pending: RECORDED,
	});
});

// ============================================================================
// Merging
// ============================================================================

const LOCAL = 'c'.repeat(40);
const FETCHED = 'd'.repeat(40);
const MERGED = 'e'.repeat(40);
const COLOR_CONFLICT = { reason: 'content', path: 'notes/color.txt' } as const;

test('a merge sends one command and maps each outcome', async () => {
	const folder = await attached();
	replies.merge_incoming = () => ({
		status: 'merged',
		from: LOCAL,
		to: MERGED,
		fetched: FETCHED,
		changedPaths: ['a.md'],
	});

	expect(expectOk(await folder.git.mergeIncoming())).toEqual({
		status: 'merged',
		from: LOCAL,
		to: MERGED,
		fetched: FETCHED,
		changedPaths: ['a.md'],
	});
	replies.merge_incoming = () => ({
		status: 'fastForwarded',
		from: null,
		to: FETCHED,
		changedPaths: [],
	});
	expect(expectOk(await folder.git.mergeIncoming())).toEqual({
		status: 'fastForwarded',
		from: undefined,
		to: FETCHED,
		changedPaths: [],
	});
	// Both options are always sent, `false` unless asked for.
	const defaults = { allowUnrelatedHistories: false, versions: false };
	expect(sent('merge_incoming').map((call) => call.args)).toEqual([
		{ session: 7, ...defaults },
		{ session: 7, ...defaults },
	]);
	await folder.close();
});

test('merge options reach the owner, and conflict versions arrive as exact bytes', async () => {
	const folder = await attached();
	const conflicts = [
		{ reason: 'binary', path: 'same.bin' },
		{ reason: 'deleted', path: 'gone.md', deletedBy: 'ours' },
	] as const;
	replies.merge_incoming = ({ args }) =>
		refuse({
			name: 'Conflicted',
			conflicts,
			versions: args.versions
				? [
						{ path: 'same.bin', ours: [0, 255, 1], theirs: [0, 254, 9] },
						{ path: 'gone.md', ours: null, theirs: [99, 10] },
					]
				: null,
		});

	const asked = expectErr(
		await folder.git.mergeIncoming({
			allowUnrelatedHistories: true,
			versions: true,
		}),
	);
	expect(asked.name).toBe('Conflicted');
	if (asked.name !== 'Conflicted') throw new Error('unreachable');
	expect(asked.conflicts).toEqual(conflicts);
	expect(asked.versions).toEqual([
		{
			path: 'same.bin',
			ours: new Uint8Array([0, 255, 1]),
			theirs: new Uint8Array([0, 254, 9]),
		},
		{ path: 'gone.md', ours: null, theirs: new Uint8Array([99, 10]) },
	]);
	for (const version of asked.versions ?? []) {
		for (const side of [version.ours, version.theirs])
			expect(side === null || side instanceof Uint8Array).toBe(true);
	}

	// Not asked: the owner's `null` is no `versions` at all, as elsewhere.
	const plain = expectErr(
		await folder.git.mergeIncoming({ allowUnrelatedHistories: true }),
	);
	if (plain.name !== 'Conflicted') throw new Error(`got ${plain.name}`);
	expect(plain.versions).toBeUndefined();

	expect(sent('merge_incoming').map((call) => call.args)).toEqual([
		{
			session: 7,
			allowUnrelatedHistories: true,
			versions: true,
		},
		{
			session: 7,
			allowUnrelatedHistories: true,
			versions: false,
		},
	]);
	await folder.close();
});

test('merge refusals keep their names, and a lost reply is Unconfirmed and sent once', async () => {
	const folder = await attached();
	for (const [refusal, expected] of [
		[
			{ name: 'Conflicted', conflicts: [COLOR_CONFLICT] },
			{ name: 'Conflicted', conflicts: [COLOR_CONFLICT] },
		],
		[
			{ name: 'UnsupportedHistory', head: LOCAL, fetched: FETCHED, bases: 2 },
			{ name: 'UnsupportedHistory', bases: 2 },
		],
		[
			{ name: 'Unmergeable', paths: ['a.md'], reason: 'merge=union' },
			{ name: 'Unmergeable', paths: ['a.md'] },
		],
		[
			{ name: 'Pull', error: { name: 'Blocked', reason: 'a merge' } },
			{ name: 'Blocked', reason: 'a merge' },
		],
		[
			{
				name: 'Pull',
				error: { name: 'Git', error: { name: 'NothingToCommit' } },
			},
			{ name: 'NothingToCommit' },
		],
	] as const) {
		replies.merge_incoming = () => refuse(refusal);
		expect(expectErr(await folder.git.mergeIncoming())).toMatchObject(expected);
	}
	calls = [];
	replies.merge_incoming = () => {
		throw new Error('the webview lost its IPC connection');
	};
	expect(expectErr(await folder.git.mergeIncoming()).name).toBe('Unconfirmed');
	expect(sent('merge_incoming')).toHaveLength(1);
	await folder.close();
});

test('the snapshot shows merge activity, its last attempt, and a pending merge publication', async () => {
	const folder = await attached();
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 4,
		snapshot: wireSnapshot({
			activity: Object.fromEntries(
				['scan', 'commit', 'push', 'fetch', 'pull', 'merge'].map((name) => [
					name,
					{ active: name === 'merge' },
				]),
			),
			lastMerge: {
				at: 5,
				result: {
					status: 'err',
					error: { name: 'Conflicted', conflicts: [COLOR_CONFLICT] },
				},
			},
			pendingIncoming: { ...RECORD, expectedHead: LOCAL, nextHead: MERGED },
		}),
	});
	const snapshot = folder.git.snapshot;
	expect(snapshot.activity.merge).toEqual({ active: true });
	expect(snapshot.lastMerge?.result.error).toMatchObject({
		name: 'Conflicted',
		conflicts: [COLOR_CONFLICT],
	});
	expect(snapshot.pendingIncoming).toEqual({
		...RECORDED,
		expectedHead: LOCAL,
		nextHead: MERGED,
	});
	await folder.close();
});

test('a staged commit names its commit and parent', async () => {
	const folder = await attached();
	replies.commit_staged = () => ({ oid: MERGED, parent: LOCAL });
	expect(expectOk(await folder.git.commitStaged('Plain'))).toEqual({
		oid: MERGED,
		parent: LOCAL,
	});
	replies.commit_staged = () => ({ oid: MERGED, parent: null });
	expect(expectOk(await folder.git.commitStaged('First'))).toEqual({
		oid: MERGED,
		parent: undefined,
	});
	await folder.close();
});

test('closing waits for a Git call already running, then detaches, and later Git calls invoke nothing', async () => {
	const folder = await attached();
	const commit = held<typeof committed>();
	replies.commit = commit.reply;

	const committing = folder.git.commit();
	const closing = folder.close();
	await Bun.sleep(20);
	// The session is still attached: the commit's reply has somewhere to land.
	expect(calls.map((call) => call.cmd)).toEqual(['commit']);
	commit.settle(committed);

	expect((await committing).status).toBe('committed');
	await closing;
	expect(calls.map((call) => call.cmd)).toEqual(['commit', 'detach']);

	calls = [];
	expect(await folder.git.commit()).toEqual({ status: 'closed' });
	expect(await folder.git.push()).toEqual({ status: 'closed' });
	expect(await folder.git.commitAndPush()).toEqual({
		commit: { status: 'closed' },
		push: { status: 'closed' },
	});
	for (const refused of [
		await folder.git.status(),
		await folder.git.fetch(),
		await folder.git.pullFastForward(),
		await folder.git.mergeIncoming(),
		await folder.git.paths(),
		await folder.git.stage('all'),
		await folder.git.commitStaged('message'),
		await folder.git.diff({ staged: false, paths: [] }),
		await folder.git.log(1),
	])
		expect(expectErr(refused).name).toBe('Closed');
	expect(calls).toEqual([]);
});

test('closing stops this page waiting for a push and a fetch and withdraws both requests before detaching', async () => {
	const folder = await attached();
	const push = held<{ status: string; oid: string }>();
	replies.push = push.reply;
	const fetch = held<{ oid: null }>();
	replies.fetch = fetch.reply;

	const pushing = folder.git.push();
	const fetching = folder.git.fetch();
	await untilSent('push');
	await untilSent('fetch');
	await folder.close();

	expect(await pushing).toEqual({ status: 'stoppedWaiting' });
	expect(expectErr(await fetching).name).toBe('StoppedWaiting');
	// Each command named a request the owner already knew, and closing
	// withdrew each one while the session still existed. What the owner had
	// not started, it will not start; the page does not learn which.
	expect(calls.map((call) => call.cmd)).toEqual([
		'open_request',
		'open_request',
		'push',
		'fetch',
		'withdraw_request',
		'withdraw_request',
		'detach',
	]);
	const requests = [FIRST_REQUEST, FIRST_REQUEST + 1];
	expect(
		[...sent('push'), ...sent('fetch')].map((call) => call.args.request).sort(),
	).toEqual(requests);
	expect(
		sent('withdraw_request')
			.map((call) => call.args)
			.sort((a, b) => Number(a.request) - Number(b.request)),
	).toEqual(requests.map((request) => ({ session: 7, request })));
	push.settle({ status: 'pushed', oid: 'c'.repeat(40) });
	fetch.settle({ oid: null });
});

test('a commit whose outcome is unknown leaves the push unknown, not skipped', async () => {
	const folder = await attached();
	replies.commit = () => {
		throw new Error('connection lost');
	};

	expect(await folder.git.commitAndPush()).toEqual({
		commit: { status: 'unconfirmed', error: 'connection lost' },
		push: { status: 'unconfirmed', error: 'connection lost' },
	});

	// A commit that may not have happened is no reason to push.
	expect(sent('push')).toHaveLength(0);
});

test('closing during a commit starts no push, even after the commit lands', async () => {
	const folder = await attached();
	// A remote exists, so a commit that completes is normally followed by a push.
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 4,
		snapshot: wireSnapshot({
			remote: { url: 'https://example.com/notes.git', branch: 'main' },
		}),
	});
	replies.push = () => ({ status: 'pushed', oid: committed.oid });
	replies.commit = () => committed;
	expect(await folder.git.commitAndPush()).toEqual({
		commit: {
			status: 'committed',
			oid: committed.oid,
			parent: undefined,
			message: 'Add a.md',
			changedPaths: 1,
			indexWarning: undefined,
		},
		push: { status: 'pushed', oid: committed.oid },
	});
	// The explicit push names the request this session opened for it.
	expect(calls.map((call) => call.cmd)).toEqual([
		'commit',
		'open_request',
		'push',
	]);
	expect(sent('push')[0]?.args).toEqual({
		session: 7,
		request: FIRST_REQUEST,
	});
	// It had its answer, so there was nothing to withdraw.
	expect(sent('withdraw_request')).toEqual([]);

	calls = [];
	const commit = held<typeof committed>();
	replies.commit = commit.reply;
	const result = folder.git.commitAndPush();
	const closing = folder.close();
	commit.settle(committed);
	expect(await result).toMatchObject({
		commit: { status: 'committed' },
		push: { status: 'closed' },
	});
	await closing;
	expect(calls.map((call) => call.cmd)).toEqual(['commit', 'detach']);
});

test('an unacknowledged push or fetch releases its opened request without retrying', async () => {
	const folder = await attached();
	replies.push = () => refuse('push not allowed');
	replies.fetch = () => {
		throw new Error('fetch reply lost');
	};

	expect(await folder.git.push()).toEqual({
		status: 'unconfirmed',
		error: 'push not allowed',
	});
	expect(expectErr(await folder.git.fetch()).name).toBe('Unconfirmed');
	expect(sent('withdraw_request').map((call) => call.args)).toEqual([
		{ session: 7, request: FIRST_REQUEST },
		{ session: 7, request: FIRST_REQUEST + 1 },
	]);
	expect(sent('push')).toHaveLength(1);
	expect(sent('fetch')).toHaveLength(1);
	await folder.close();
});

test('a fetch the owner never started for a withdrawn caller is reported as stopped waiting', async () => {
	const folder = await attached();
	replies.fetch = () => refuse({ name: 'Withdrawn' });
	replies.push = () => ({ status: 'cancelled', oid: null });

	expect(expectErr(await folder.git.fetch()).name).toBe('StoppedWaiting');
	expect(await folder.git.push()).toEqual({
		status: 'cancelled',
		oid: undefined,
	});
});

test('a push the owner refuses before pinning a commit names no commit', async () => {
	const folder = await attached();
	replies.push = () =>
		refuse({
			name: 'Denied',
			reason: 'this window has no such folder session',
		});

	const refused = await folder.git.push();

	expect(refused).toEqual({
		status: 'skipped',
		reason: 'Git push failed: this window has no such folder session',
	});
	replies.push = () => ({
		status: 'skipped',
		reason: 'git rev-parse: bad ref',
	});
	expect(await folder.git.push()).toEqual({
		status: 'skipped',
		reason: 'git rev-parse: bad ref',
	});
});

test('closing detaches this window once and later work is refused as closed', async () => {
	const folder = await attached();
	replies.read = () => ({
		bytes: [1],
		sha256: 'b'.repeat(64),
	});
	expectOk(await folder.files.read('a.md'));

	await Promise.all([folder.close(), folder.close()]);

	expect(sent('detach')).toEqual([{ cmd: 'detach', args: { session: 7 } }]);
	expect(folder.signal.aborted).toBe(true);
	expect(expectErr(await folder.files.read('a.md')).name).toBe('Closed');
	expect(sent('read')).toHaveLength(1);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test('a desktop folder does not sync yet, and says so before anything is sent', async () => {
	const folder = await attached();
	expect(folder.sync.supported).toBe(false);
	expect(expectErr(await folder.sync.run())).toMatchObject({
		name: 'Unsupported',
		runtime: 'desktop',
	});
	expect(calls).toEqual([]);
});
