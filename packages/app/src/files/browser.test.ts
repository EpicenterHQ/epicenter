/**
 * Browser folders over fake IndexedDB with real isomorphic-git objects.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import * as isogit from 'isomorphic-git';
import { defineStore, defineTable, field, plainText } from '../index.js';
import {
	createBrowserFileBoundary,
	type IndexedDbEnvironment,
	openFolderDatabase,
} from './browser-store.js';
import { createBrowserGitBackend } from './git/browser-backend.js';
import { createGitSession, GITDIR } from './git/browser-fs.js';
import { createHistory } from './git/history.js';
import { type Folder, openBrowserFolder } from './index.js';
import { createFolderTerminal } from './terminal.js';

const definition = defineStore({
	id: 'so.epicenter.todostest',
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const author = { name: 'Browser', email: 'browser@example.test' };

let environment: IndexedDbEnvironment;
const opened: Folder<typeof definition>[] = [];

async function open(options: { commitOnEdit?: boolean; id?: string } = {}) {
	environment ??= { indexedDB: new IDBFactory(), IDBKeyRange };
	const folder = await openBrowserFolder({
		id: options.id ?? 'test',
		definition,
		git: { author, commitOnEdit: options.commitOnEdit },
		indexedDb: environment,
	});
	opened.push(folder);
	return folder;
}

afterEach(async () => {
	for (const folder of opened.splice(0)) await folder.close();
	environment = { indexedDB: new IDBFactory(), IDBKeyRange };
});

/** Wait for background commit work to settle. */
async function settled(folder: Folder<typeof definition>) {
	for (let index = 0; index < 200; index++) {
		const { activity } = folder.git.snapshot;
		if (
			!activity.commit.active &&
			!activity.commit.pending &&
			!activity.push.active
		)
			return;
		await Bun.sleep(5);
	}
	throw new Error('Git work did not settle');
}

describe('browser folder tables', () => {
	test('creates, lists, updates, completes, renames, and deletes plain Markdown rows', async () => {
		const folder = await open({ commitOnEdit: false });
		const created = await folder.tables.todos.create({
			stem: 'milk',
			fields: { title: 'Buy milk', done: false },
			body: 'Two liters.\n',
		});
		expect(created.error).toBeNull();
		expect(created.data!.path).toBe('todos/milk.md');
		expect(created.data!.source).toBe(
			'---\ntitle: Buy milk\ndone: false\n---\nTwo liters.\n',
		);
		const raw = await folder.files.read('todos/milk.md');
		expect(new TextDecoder().decode(raw.data!.bytes)).toBe(
			created.data!.source,
		);
		expect(raw.data!.version).toEqual(created.data!.version);

		const completed = await folder.tables.todos.update(created.data!, {
			fields: { done: true },
		});
		expect(completed.data!.fields).toEqual({ title: 'Buy milk', done: true });
		expect(completed.data!.body).toBe('Two liters.\n');

		const renamed = await folder.tables.todos.rename(
			completed.data!,
			'groceries',
		);
		expect(renamed.data!.path).toBe('todos/groceries.md');
		expect((await folder.tables.todos.get('milk')).data).toBeUndefined();
		const listed = await folder.tables.todos.list();
		expect(listed.data!.entries.map((entry) => entry.stem)).toEqual([
			'groceries',
		]);

		const removed = await folder.tables.todos.delete(renamed.data!);
		expect(removed.data!.removed).toEqual(['todos/groceries.md']);
		expect((await folder.tables.todos.list()).data!.entries).toEqual([]);
	});

	test('a stale captured entry is refused and the file is unchanged', async () => {
		const folder = await open({ commitOnEdit: false });
		const first = (
			await folder.tables.todos.create({
				stem: 'a',
				fields: { title: 'A', done: false },
			})
		).data!;
		const newer = (
			await folder.tables.todos.update(first, { fields: { title: 'Newer' } })
		).data!;
		const stale = await folder.tables.todos.update(first, {
			fields: { done: true },
		});
		expect(stale.error?.name).toBe('Conflict');
		expect((await folder.tables.todos.get('a')).data!.source).toBe(
			newer.source,
		);
		// An unchanged write still checks its precondition.
		const same = await folder.tables.todos.writeSource(first, first.source);
		expect(same.error?.name).toBe('Conflict');
	});

	test('create is exclusive and refuses case-insensitive collisions', async () => {
		const folder = await open({ commitOnEdit: false });
		await folder.tables.todos.create({
			stem: 'Plan',
			fields: { title: 'P', done: false },
		});
		expect(
			(
				await folder.tables.todos.create({
					stem: 'Plan',
					fields: { title: 'Q', done: false },
				})
			).error?.name,
		).toBe('Exists');
		expect(
			(
				await folder.tables.todos.create({
					stem: 'plan',
					fields: { title: 'Q', done: false },
				})
			).error?.name,
		).toBe('Collision');
		expect(
			(
				await folder.tables.todos.create({
					stem: '../x',
					fields: { title: 'Q', done: false },
				})
			).error?.name,
		).toBe('InvalidStem');
		expect(
			(
				await folder.tables.todos.create({
					stem: 'ok',
					fields: { title: 3 as unknown as string, done: false },
				})
			).error?.name,
		).toBe('InvalidValues');
	});

	test('invalid readable rows stay entries with issues and independently valid fields', async () => {
		const folder = await open({ commitOnEdit: false });
		const source =
			'﻿---\r\ntitle: Kept # comment\r\ndone: maybe\r\nextra: unknown\r\n---\r\nBody\r\n';
		await folder.files.write('todos/odd.md', source, { expected: 'absent' });
		await folder.files.write('todos/broken.md', '---\ntitle: [\n---\n', {
			expected: 'absent',
		});
		await folder.files.write(
			'todos/bad.md',
			new Uint8Array([0xff, 0xfe, 0x00]),
			{ expected: 'absent' },
		);
		const listed = (await folder.tables.todos.list()).data!;
		expect(listed.unreadable.map((item) => item.path)).toEqual([
			'todos/bad.md',
		]);
		const odd = listed.entries.find((entry) => entry.path === 'todos/odd.md')!;
		expect(odd.source).toBe(source);
		expect(odd.issues?.map((issue) => issue.kind)).toEqual(['field']);
		expect(odd.fields).toEqual({ title: 'Kept' });
		expect(odd.stem).toBe('odd');

		// A typed update of the valid-in-isolation field replaces only that span.
		const fixed = await folder.tables.todos.update(odd, {
			fields: { done: true },
		});
		expect(fixed.data!.source).toBe(
			source.replace('done: maybe', 'done: true'),
		);
		expect(fixed.data!.issues).toBeUndefined();

		const broken = listed.entries.find(
			(entry) => entry.path === 'todos/broken.md',
		)!;
		expect(broken.issues?.[0]?.kind).toBe('frontmatter');
		expect(
			(await folder.tables.todos.update(broken, { fields: { done: true } }))
				.error?.name,
		).toBe('UnsupportedSource');
		const repaired = await folder.tables.todos.writeSource(
			broken,
			'---\ntitle: Repaired\ndone: false\n---\n',
		);
		expect(repaired.data!.issues).toBeUndefined();
		expect(repaired.data!.fields.title).toBe('Repaired');
	});

	test('attachments: one same-stem sibling is owned; several are ambiguous and block delete', async () => {
		const folder = await open({ commitOnEdit: false });
		const created = await folder.tables.todos.create({
			stem: 'rec',
			fields: { title: 'Recording', done: false },
			attachment: { extension: 'opus', bytes: new Uint8Array([1, 2, 3]) },
		});
		expect(created.data!.attachment).toBe('todos/rec.opus');
		const renamed = (await folder.tables.todos.rename(created.data!, 'rec2'))
			.data!;
		expect(renamed.attachment).toBe('todos/rec2.opus');
		expect((await folder.files.read('todos/rec2.opus')).data!.bytes).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		await folder.files.write('todos/rec2.wav', new Uint8Array([9]), {
			expected: 'absent',
		});
		const ambiguous = (await folder.tables.todos.get('rec2')).data!;
		expect(ambiguous.attachment).toBeUndefined();
		expect(ambiguous.issues?.[0]?.kind).toBe('attachment');
		expect((await folder.tables.todos.delete(ambiguous)).error?.name).toBe(
			'AmbiguousAttachment',
		);
		// `meeting.source.md` is its own row, not an attachment of `meeting.md`.
		await folder.files.write(
			'todos/rec2.take.md',
			'---\ntitle: T\ndone: false\n---\n',
			{ expected: 'absent' },
		);
		expect(
			(await folder.tables.todos.get('rec2.take')).data!.issues,
		).toBeUndefined();
	});

	test('rejects a definition that supplies a Yjs body codec', async () => {
		const withCodec = defineStore({
			id: 'so.epicenter.codec',
			kv: {},
			tables: {
				notes: defineTable({
					fields: { title: field.string() },
					body: plainText(),
				}),
			},
		});
		await expect(
			openBrowserFolder({
				id: 'codec',
				definition: withCodec,
				git: { author },
				indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
			}),
		).rejects.toThrow('Yjs body codec');
	});

	test('rejects reference fields it cannot repair on rename', async () => {
		const withReference = defineStore({
			id: 'so.epicenter.references',
			kv: {},
			tables: {
				lists: defineTable({ fields: { title: field.string() } }),
				todos: defineTable({
					fields: { title: field.string(), list: field.reference('lists') },
				}),
			},
		});
		await expect(
			openBrowserFolder({
				id: 'references',
				definition: withReference,
				git: { author },
				indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
			}),
		).rejects.toThrow("Field 'todos.list' is a reference");
	});

	test('a todo with an unresolvable alias stays an entry and is repaired through its source', async () => {
		const folder = await open({ commitOnEdit: false });
		const source = '---\ntitle: *missing\ndone: false\n---\nNotes stay.\n';
		await folder.files.write('todos/alias.md', source, { expected: 'absent' });
		const listed = (await folder.tables.todos.list()).data!;
		expect(listed.unreadable).toEqual([]);
		const entry = listed.entries.find(
			(item) => item.path === 'todos/alias.md',
		)!;
		expect(entry.source).toBe(source);
		expect(entry.body).toBe('Notes stay.\n');
		expect(entry.issues?.[0]?.kind).toBe('frontmatter');
		expect(entry.issues?.[0]?.message).toContain('Unresolved alias');

		// A structured edit, as the editor's title field makes, is refused safely.
		const edited = await folder.tables.todos.update(entry, {
			fields: { title: 'Fixed' },
		});
		expect(edited.error?.name).toBe('UnsupportedSource');
		expect((await folder.tables.todos.get('alias')).data!.source).toBe(source);

		const repaired = await folder.tables.todos.writeSource(
			entry,
			source.replace('*missing', 'Fixed'),
		);
		expect(repaired.data!.issues).toBeUndefined();
		expect(repaired.data!.fields).toEqual({ title: 'Fixed', done: false });
	});

	test('kv.json is conditional and preserves unknown keys', async () => {
		const folder = await open({ commitOnEdit: false });
		const empty = (await folder.kv.get()).data!;
		expect(empty.version).toBeUndefined();
		await folder.files.write('kv.json', '{"other": 1}', { expected: 'absent' });
		expect((await folder.kv.update(empty, { theme: 'dark' })).error?.name).toBe(
			'Conflict',
		);
		const current = (await folder.kv.get()).data!;
		const updated = await folder.kv.update(current, { theme: 'dark' });
		expect(updated.data!.source).toBe(
			'{\n  "other": 1,\n  "theme": "dark"\n}\n',
		);
	});
});

describe('browser folder persistence and history', () => {
	test('files, directories, and history survive reopening the database', async () => {
		const first = await open();
		await first.tables.todos.create({
			stem: 'kept',
			fields: { title: 'Kept', done: false },
		});
		await first.files.mkdir('empty/dir');
		await settled(first);
		const head = first.git.snapshot.lastCommit;
		expect(head?.status).toBe('committed');
		await first.close();

		const second = await open();
		expect((await second.tables.todos.get('kept')).data!.fields.title).toBe(
			'Kept',
		);
		expect((await second.files.children('empty')).data!.directories).toEqual([
			'dir',
		]);
		const log = await second.git.log(10);
		expect(log.data!.map((commit) => commit.message)).toEqual([
			'Add todos/kept.md\n',
		]);
		const status = await second.git.status();
		expect(status.data!.changes).toEqual([]);
	});

	test('a save returns before its automatic commit; coalesced saves share the next pass', async () => {
		const folder = await open();
		const a = (
			await folder.tables.todos.create({
				stem: 'a',
				fields: { title: 'A', done: false },
			})
		).data!;
		// The save already returned; history is still running or pending.
		expect(folder.git.snapshot.activity.commit.active).toBe(true);
		await folder.tables.todos.create({
			stem: 'b',
			fields: { title: 'B', done: false },
		});
		await folder.tables.todos.update(a, { fields: { done: true } });
		await settled(folder);
		const log = (await folder.git.log(10)).data!.map((commit) =>
			commit.message.trim(),
		);
		expect(log[log.length - 1]).toBe('Add todos/a.md');
		expect(log.length).toBeLessThanOrEqual(3);
		const status = await folder.git.status();
		expect(status.data!.changes).toEqual([]);
	});

	test('raw writes do not request commits; status reports them as uncommitted', async () => {
		const folder = await open();
		await folder.files.write('notes/raw.txt', 'hello', { expected: 'absent' });
		await Bun.sleep(20);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		const status = await folder.git.status();
		expect(status.data!.changes).toEqual([
			{ path: 'notes/raw.txt', kind: 'add' },
		]);
		const outcome = await folder.git.commit();
		expect(outcome.status).toBe('committed');
		if (outcome.status === 'committed')
			expect(outcome.message).toBe('Add notes/raw.txt');
		expect((await folder.git.commit()).status).toBe('unchanged');
	});

	test('subscribe delivers the cached snapshot synchronously, unknown before the first scan', async () => {
		const folder = await open({ commitOnEdit: false });
		const seen: string[] = [];
		const unsubscribe = folder.git.subscribe((snapshot) =>
			seen.push(snapshot.files.state),
		);
		expect(seen).toEqual(['unknown']);
		expect(folder.git.snapshot.commitOnEdit).toBe(false);
		await folder.git.status();
		expect(seen.at(-1)).toBe('observed');
		await folder.files.write('x.txt', 'x', { expected: 'absent' });
		const files = folder.git.snapshot.files;
		expect(files.state === 'observed' && files.stale).toBe(true);
		unsubscribe();
	});

	test('commitOnEdit false suppresses implicit commits; commitAndPush still commits', async () => {
		const folder = await open({ commitOnEdit: false });
		await folder.tables.todos.create({
			stem: 'manual',
			fields: { title: 'M', done: false },
		});
		await Bun.sleep(20);
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		const result = await folder.git.commitAndPush();
		expect(result.commit.status).toBe('committed');
		expect(result.push.status).toBe('noRemote');
	});

	test('a stalled push blocks neither saves nor commits; close cancels pushes and settles', async () => {
		const originalFetch = globalThis.fetch;
		let requests = 0;
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
			requests++;
			return new Promise<Response>((_resolve, reject) =>
				init?.signal?.addEventListener('abort', () =>
					reject(new DOMException('The push was cancelled', 'AbortError')),
				),
			);
		}) as typeof fetch;
		try {
			environment = { indexedDB: new IDBFactory(), IDBKeyRange };
			const folder = await openBrowserFolder({
				id: 'stall',
				definition,
				git: {
					author,
					remote: { url: 'http://stall.test/remote.git', branch: 'main' },
				},
				indexedDb: environment,
			});
			await folder.tables.todos.create({
				stem: 'a',
				fields: { title: 'A', done: false },
			});
			for (let index = 0; index < 200 && requests === 0; index++)
				await Bun.sleep(5);
			expect(folder.git.snapshot.activity.push.active).toBe(true);

			const saved = await folder.tables.todos.create({
				stem: 'b',
				fields: { title: 'B', done: false },
			});
			expect(saved.error).toBeNull();
			for (let index = 0; index < 200; index++) {
				if (
					folder.git.snapshot.lastCommit?.status === 'committed' &&
					folder.git.snapshot.activity.push.pending
				)
					break;
				await Bun.sleep(5);
			}
			const lastCommit = folder.git.snapshot.lastCommit;
			expect(lastCommit?.status === 'committed' && lastCommit.message).toBe(
				'Add todos/b.md',
			);
			expect(folder.git.snapshot.activity.push.active).toBe(true);
			expect(folder.git.snapshot.activity.push.pending).toBe(true);

			await folder.close();
			expect(folder.git.snapshot.lastPush?.status).toBe('cancelled');
			expect(folder.git.snapshot.activity.push).toEqual({
				active: false,
				pending: false,
			});
			expect(requests).toBe(1);
			expect((await folder.tables.todos.list()).error?.name).toBe('Closed');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test('a competing branch update refuses the checkpoint without a forced update', async () => {
		environment = { indexedDB: new IDBFactory(), IDBKeyRange };
		const db = await openFolderDatabase('epicenter-folder:cas', environment);
		const boundary = createBrowserFileBoundary(db, environment);
		const backend = await createBrowserGitBackend({
			db,
			environment,
			lockName: 'cas',
			branch: 'main',
			remote: undefined,
		});
		let competitor: string | undefined;
		const history = createHistory({
			backend: {
				...backend,
				async casBranch(expected, next) {
					// Another writer moves the branch between capture and publication.
					competitor = await backend.withObjects((access) =>
						isogit.writeCommit({
							...access,
							commit: {
								tree: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
								parent: [],
								author: { ...author, timestamp: 1, timezoneOffset: 0 },
								committer: { ...author, timestamp: 1, timezoneOffset: 0 },
								message: 'Competitor\n',
							},
						}),
					);
					await isogit.writeTree({ ...(await sessionAccess()), tree: [] });
					expect((await backend.casBranch(expected, competitor)).ok).toBe(true);
					return backend.casBranch(expected, next);
				},
			},
			boundary,
			author,
			commitOnEdit: false,
		});
		async function sessionAccess() {
			const session = createGitSession(db, environment);
			return { fs: session.fs, gitdir: GITDIR };
		}
		await boundary.apply([
			{
				kind: 'write',
				path: 'a.txt',
				bytes: new TextEncoder().encode('a'),
				version: {
					sha256:
						'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
					size: 1,
				},
				expected: 'absent',
			},
		]);
		const outcome = await history.commit();
		expect(outcome.status).toBe('branchMoved');
		if (outcome.status === 'branchMoved') {
			expect(outcome.actual).toBe(competitor);
			expect(outcome.candidate).not.toBe(competitor);
		}
		expect(await backend.readBranch()).toBe(competitor);
		await history.close();
		db.close();
	});
});

describe('browser terminal', () => {
	test('shell reads and writes the same files; git staging semantics are real', async () => {
		const folder = await open({ commitOnEdit: false });
		const terminal = createFolderTerminal(folder);
		await folder.tables.todos.create({
			stem: 'one',
			fields: { title: 'One', done: false },
		});

		expect((await terminal.exec('ls todos')).stdout).toBe('one.md\n');
		expect((await terminal.exec('cat todos/one.md')).stdout).toContain(
			'title: One',
		);
		const wrote = await terminal.exec(
			'echo "shell note" > notes.txt && mkdir -p a/b && ls',
		);
		expect(wrote.exitCode).toBe(0);
		expect(wrote.stdout.split('\n')).toContain('notes.txt');
		expect(
			new TextDecoder().decode(
				(await folder.files.read('notes.txt')).data!.bytes,
			),
		).toBe('shell note\n');
		// A shell write requests no automatic commit even when enabled elsewhere.
		expect(folder.git.snapshot.lastCommit).toBeUndefined();

		let status = await terminal.exec('git status');
		expect(status.stdout).toBe('## main\n?? notes.txt\n?? todos/one.md\n');
		expect((await terminal.exec('git add notes.txt')).exitCode).toBe(0);
		status = await terminal.exec('git status');
		expect(status.stdout).toBe('## main\nA  notes.txt\n?? todos/one.md\n');
		const committed = await terminal.exec('git commit -m "Add a shell note"');
		expect(committed.exitCode).toBe(0);
		expect(committed.stdout).toMatch(
			/^\[main [0-9a-f]{7}\] Add a shell note\n$/,
		);
		expect(folder.git.snapshot.lastCommit).toMatchObject({
			status: 'committed',
			message: 'Add a shell note',
			changedPaths: 1,
		});
		status = await terminal.exec('git status');
		expect(status.stderr).toBe('');
		expect(status.stdout).toBe('## main\n?? todos/one.md\n');

		await terminal.exec('echo "more" >> notes.txt');
		status = await terminal.exec('git status --short');
		expect(status.stdout).toBe('## main\n M notes.txt\n?? todos/one.md\n');
		const diff = await terminal.exec('git diff');
		expect(diff.stdout).toContain('+more');
		expect(diff.stdout).toContain('diff --git a/notes.txt b/notes.txt');
		await terminal.exec('git add -A');
		expect((await terminal.exec('git diff --cached')).stdout).toContain(
			'+more',
		);
		expect((await terminal.exec('git commit -m "   "')).exitCode).not.toBe(0);
		expect((await terminal.exec('git commit -m "Second"')).exitCode).toBe(0);
		expect((await terminal.exec('git log --oneline')).stdout).toMatch(
			/^[0-9a-f]{7} Second\n[0-9a-f]{7} Add a shell note\n$/,
		);
		expect((await terminal.exec('git commit -m "Nothing"')).stderr).toBe(
			'nothing added to commit\n',
		);
		expect((await terminal.exec('git rebase main')).exitCode).toBe(1);

		// Automatic checkpoints keep the index consistent with the new head.
		await terminal.exec('echo "auto" > auto.txt');
		expect((await folder.git.commit()).status).toBe('committed');
		expect((await terminal.exec('git status')).stdout).toBe(
			'## main\nnothing to commit, working tree clean\n',
		);
		expect((await terminal.exec('rm auto.txt && git status')).stdout).toBe(
			'## main\n D auto.txt\n',
		);
		expect((await terminal.exec('cd todos && pwd')).stdout).toBe('/todos\n');
		expect(terminal.cwd).toBe('/todos');
	});
});
