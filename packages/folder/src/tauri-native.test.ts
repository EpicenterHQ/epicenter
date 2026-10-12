/**
 * Tauri Folder Adapter Conformance Tests (real native owner)
 *
 * The adapter in `tauri.ts` against the Rust folder owner itself: every
 * `invoke` here crosses Tauri's real command handler on its mock runtime, and
 * the folder is a real directory with a real Git repository. Two "windows"
 * share one owner, as two pages of a shell do.
 *
 * This needs a Rust toolchain and the plugin's dependencies, so it runs only
 * when `EPICENTER_FOLDER_BRIDGE=1`:
 *
 *     EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts
 *
 * `EPICENTER_FOLDER_BRIDGE_BINARY` names an already built test binary of the
 * plugin to run instead of building one.
 *
 * Key behaviors:
 * - A window attaches only to a scope registered for it, and learns the root
 * - Tables, raw files, and Git work through the adapter; a save makes no
 *   commit, and a commit records what the saves left (ADR-0529)
 * - A page built for the previous protocol is refused at attach
 * - Two windows saving over one version: one lands, one conflicts
 * - A save the shell receives after a later save of its page landed on the
 *   same path lands over it and stays, whether it was late in transit or
 *   still hashing, through any handle of the page
 * - A guarded table replace still hashing when a raw save lands is refused
 *   as an exact-sha256 conflict, and the raw save stays
 * - A row another window changed after a table's directory read is still an
 *   exact-sha256 conflict
 * - A terminal command holds nothing: another window saves, commits, and runs
 *   a whole terminal command of its own, between its steps; a terminal's save
 *   makes no commit, like any other
 * - Binary pipelines and directory tree moves use the real owner's file commands
 * - A terminal's rewrite of a file it read is refused when another window
 *   wrote between its steps, and the steps before it stay landed
 * - A terminal `git fetch` in flight at the remote delays no save and no commit
 * - A terminal `git merge` of red against green is refused and writes
 *   nothing; a merge the person's own Git begins blocks commits, staged
 *   commits, and merges until Git outside Epicenter finishes it
 * - Closing a page mid-command stops the command's later steps; the save the
 *   owner already admitted lands, and closing commits nothing
 * - Closing one window's folder leaves the other window and the owner
 *   working, and its last save stays in the folder for the next commit
 *
 * See also:
 * - `tauri.test.ts` for what the adapter decides on its own
 * - `native-best-effort.test.ts` for what file-backed tables do not promise
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import { readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSink } from 'bun';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';
import { formatDeclaration } from './declaration.js';
import {
	createBareRemote,
	git,
	gitHttpFetch,
	scratch,
} from './git-http.test-support.js';

const enabled = process.env.EPICENTER_FOLDER_BRIDGE === '1';
const MANIFEST = join(
	import.meta.dir,
	'../../tauri-plugin-epicenter-folder/Cargo.toml',
);
/** A prebuilt plugin test binary to run instead of building one with cargo. */
const PREBUILT = process.env.EPICENTER_FOLDER_BRIDGE_BINARY;

type Listener = (event: { payload: unknown }) => void;

/** The Rust process that owns the folder, reached line by line. */
class Bridge {
	private next = 1;
	private readonly waiting = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: unknown) => void }
	>();
	private readonly listeners = new Map<string, Set<Listener>>();
	/** Runs once, after the next directory listing returns and before the caller sees it. */
	afterListing: (() => Promise<void>) | undefined;
	/** Hold delivery to the owner, or hold its actual reply before the page sees it. */
	beforeApply: (() => Promise<void>) | undefined;
	afterApply: (() => Promise<void>) | undefined;

	private constructor(
		private readonly child: ReturnType<typeof Bun.spawn>,
		readonly root: string,
	) {}

	static async start(options: { remote?: string } = {}): Promise<Bridge> {
		const root = await realpath(await scratch('tauri-folder-'));
		const harness = [
			'tests::invoke_bridge',
			'--ignored',
			'--exact',
			'--nocapture',
		];
		const child = Bun.spawn(
			// A prebuilt test binary of the plugin is the same harness without
			// the build: `cargo test --no-run` produces it.
			PREBUILT === undefined
				? [
						'cargo',
						'test',
						'--offline',
						'--quiet',
						'--manifest-path',
						MANIFEST,
						'-p',
						'tauri-plugin-epicenter-folder',
						'--lib',
						harness[0] as string,
						'--',
						...harness.slice(1),
					]
				: [PREBUILT, ...harness],
			{
				stdin: 'pipe',
				stdout: 'pipe',
				stderr: 'inherit',
				env: {
					...process.env,
					FOLDER_BRIDGE_ROOT: root,
					...(options.remote ? { FOLDER_BRIDGE_REMOTE: options.remote } : {}),
				},
			},
		);
		const bridge = new Bridge(child, root);
		const { promise: ready, resolve } = Promise.withResolvers<void>();
		void bridge.pump(resolve);
		await ready;
		return bridge;
	}

	private async pump(ready: () => void) {
		const reader = (
			this.child.stdout as ReadableStream<Uint8Array>
		).getReader();
		const decoder = new TextDecoder();
		let buffered = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			buffered += decoder.decode(value, { stream: true });
			let newline = buffered.indexOf('\n');
			while (newline >= 0) {
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				newline = buffered.indexOf('\n');
				// The test harness prints on the same stream; a reply can share a line.
				const at = line.indexOf('FOLDER_BRIDGE ');
				if (at < 0) continue;
				const message = JSON.parse(line.slice(at + 'FOLDER_BRIDGE '.length));
				if (message.ready) ready();
				else if (message.event !== undefined) {
					const key = `${message.window}\n${message.event}`;
					for (const listener of this.listeners.get(key) ?? [])
						listener({ payload: message.payload });
				} else if (message.id !== undefined) {
					const pending = this.waiting.get(message.id);
					this.waiting.delete(message.id);
					if ('ok' in message) pending?.resolve(message.ok);
					else pending?.reject(message.err);
				}
			}
		}
	}

	async invoke(window: string, cmd: string, args: unknown): Promise<unknown> {
		if (cmd === 'plugin:epicenter-folder|apply') {
			const hook = this.beforeApply;
			this.beforeApply = undefined;
			await hook?.();
		}
		const id = this.next++;
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		this.waiting.set(id, { resolve, reject });
		const stdin = this.child.stdin as FileSink;
		stdin.write(`${JSON.stringify({ id, window, cmd, args })}\n`);
		await stdin.flush();
		const reply = await promise;
		if (cmd === 'plugin:epicenter-folder|apply') {
			const hook = this.afterApply;
			this.afterApply = undefined;
			await hook?.();
		}
		if (
			cmd === 'plugin:epicenter-folder|children' ||
			cmd === 'plugin:epicenter-folder|list'
		) {
			const hook = this.afterListing;
			this.afterListing = undefined;
			await hook?.();
		}
		return reply;
	}

	listen(window: string, event: string, listener: Listener) {
		const key = `${window}\n${event}`;
		const set = this.listeners.get(key) ?? new Set();
		this.listeners.set(key, set);
		set.add(listener);
		return () => set.delete(listener);
	}

	async stop() {
		await (this.child.stdin as FileSink).end();
		await this.child.exited;
		await rm(this.root, { recursive: true, force: true });
	}
}

let bridge: Bridge | undefined;
/** Which window the code running now belongs to. */
const windowLabel = new AsyncLocalStorage<string>();
const current = () => {
	const label = windowLabel.getStore();
	if (label === undefined) throw new Error('run this inside a window');
	return label;
};
const active = () => {
	if (bridge === undefined) throw new Error('no bridge is running');
	return bridge;
};

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => true,
	invoke: (cmd: string, args: unknown = {}) =>
		active().invoke(current(), cmd, args),
}));
mock.module('@tauri-apps/api/event', () => ({
	listen: async (event: string, listener: Listener) =>
		active().listen(current(), event, listener),
}));

const { openFolder } = await import('./tauri.js');
const { commands, FOLDER_PROTOCOL } = await import('./native/bindings.gen.js');

const definition = defineFolder({
	kv: { theme: field.string() },
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Run code as one window. Everything it awaits keeps that window. */
const as =
	(label: string) =>
	<T>(work: () => Promise<T>): Promise<T> =>
		windowLabel.run(label, work);
const a = as('a');
const b = as('b');

async function setup(options: { remote?: string } = {}) {
	bridge = await Bridge.start(options);
	const running = bridge;
	const attach = (window: ReturnType<typeof as>) =>
		window(async () => expectOk(await openFolder({ id: 'notes', definition })));
	const folder = await attach(a);
	const other = await attach(b);
	return {
		root: running.root,
		folder,
		other,
		todos: folder.tables.todos,
		/** A write from window B, landing right after window A's next directory read. */

		files: async () => {
			const { data: listed, error: listError } = await a(() =>
				folder.files.children('todos'),
			);
			return listError !== null ? [] : listed.files;
		},
	};
}

afterEach(async () => {
	await bridge?.stop();
	bridge = undefined;
});

/**
 * How a terminal command failed. A file step the folder refused ends the
 * command, as a failed result or as the folder's own error thrown out of a
 * redirection.
 */
const failure = (running: Promise<{ exitCode: number; stderr: string }>) =>
	running.then(
		(result) => {
			expect(result.exitCode).not.toBe(0);
			return result.stderr;
		},
		(error: Error) => error.message,
	);

/**
 * A bare remote with one commit, served over real Git smart HTTP on a local
 * port. Every request waits until `release`, so a `git fetch` the owner
 * started stays in flight for as long as the test needs.
 */
class HeldRemote {
	private constructor(
		private readonly server: ReturnType<typeof Bun.serve>,
		private readonly directory: string,
		private readonly gate: PromiseWithResolvers<void>,
		private readonly counts: { answered: number },
		readonly url: string,
		/** The remote branch's commit. */
		readonly head: string,
		/** Resolves when the first request has reached the remote. */
		readonly arrived: Promise<void>,
	) {}

	static async start(): Promise<HeldRemote> {
		const directory = await realpath(await scratch('tauri-folder-remote-'));
		const bare = await createBareRemote(directory);
		const seed = join(directory, 'seed');
		await git(directory, 'init', '--quiet', '--initial-branch=main', seed);
		await writeFile(join(seed, 'upstream.md'), 'from the remote\n');
		await git(seed, 'add', '--all');
		await git(seed, 'commit', '--quiet', '-m', 'upstream');
		await git(seed, 'push', '--quiet', bare, 'main');
		const head = await git(seed, 'rev-parse', 'HEAD');

		const backend = await gitHttpFetch(directory);
		const gate = Promise.withResolvers<void>();
		const arrived = Promise.withResolvers<void>();
		const counts = { answered: 0 };
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			idleTimeout: 255,
			async fetch(request) {
				arrived.resolve();
				const body =
					request.method === 'GET' ? undefined : await request.arrayBuffer();
				await gate.promise;
				counts.answered++;
				const { pathname, search } = new URL(request.url);
				return backend(`http://git.test${pathname}${search}`, {
					method: request.method,
					headers: request.headers,
					body,
				});
			},
		});
		return new HeldRemote(
			server,
			directory,
			gate,
			counts,
			`http://127.0.0.1:${server.port}/remote.git`,
			head,
			arrived.promise,
		);
	}

	/** How many requests the remote has answered. */
	answered() {
		return this.counts.answered;
	}

	release() {
		this.gate.resolve();
	}

	async stop() {
		await this.server.stop(true);
		await rm(this.directory, { recursive: true, force: true });
	}
}

/** `create` arguments for a valid row at `stem`. */
const row = (stem: string) =>
	[{ fields: { title: stem, done: false }, body: '' }, { stem }] as const;
const IMAGE = new Uint8Array([1, 2, 3]);

describe.skipIf(!enabled)('tauri folder against the native owner', () => {
	test('opening publishes root discovery JSON and makes no commit; identical reopening leaves nothing to commit', async () => {
		const { root, folder } = await setup();
		expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
			formatDeclaration(definition),
		);
		expect(await git(root, 'status', '--porcelain')).toBe('?? epicenter.json');
		expect((await a(() => folder.git.commit())).status).toBe('committed');
		const before = await git(root, 'rev-parse', 'HEAD');
		expect(await git(root, 'rev-list', '--count', 'HEAD')).toBe('1');
		const reopened = expectOk(
			await a(() => openFolder({ id: 'notes', definition })),
		);
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		expect((await a(() => reopened.git.commit())).status).toBe('unchanged');
		await a(() => reopened.close());
	});

	test('native opening replaces the previous description without committing or changing saved row bytes', async () => {
		const { root, folder } = await setup();
		expectOk(await a(() => folder.tables.todos.create(...row('kept'))));
		const before = await readFile(join(root, 'todos/kept.md'), 'utf8');
		expectOk(
			await a(() =>
				folder.files.overwrite('epicenter.json', 'manual description'),
			),
		);
		const changed = defineFolder({
			...definition,
			title: 'Changed declaration',
		});
		const reopened = expectOk(
			await a(() => openFolder({ id: 'notes', definition: changed })),
		);
		expect(await readFile(join(root, 'epicenter.json'), 'utf8')).toBe(
			formatDeclaration(changed),
		);
		expect(await readFile(join(root, 'todos/kept.md'), 'utf8')).toBe(before);
		expect(await a(() => reopened.git.log(10))).toEqual({
			data: [],
			error: null,
		});
		await a(() => reopened.close());
	});

	test('a kv set creates kv.json and keeps untouched raw values through the native owner', async () => {
		const { root, folder, other } = await setup();
		expect(
			await a(async () => expectOk(await folder.kv.get())),
		).toBeUndefined();
		const created = await a(async () =>
			expectOk(await folder.kv.set('theme', 'dark')),
		);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(
			'{\n  "theme": "dark"\n}\n',
		);
		const source =
			'{"huge":9007199254740993,"nested":{"overflow":1e400},"theme":"dark"}';
		await a(async () => expectOk(await folder.files.replace(created, source)));
		const updated = await b(async () =>
			expectOk(await other.kv.set('theme', 'light')),
		);
		expect(await readFile(join(root, 'kv.json'), 'utf8')).toBe(
			'{\n  "huge": 9007199254740993,\n  "nested": {"overflow":1e400},\n  "theme": "light"\n}\n',
		);
		expect(await a(async () => expectOk(await folder.kv.get()))).toEqual(
			updated,
		);
	});

	test('a window attaches only to a scope registered for it, and learns the root', async () => {
		bridge = await Bridge.start();
		const { root } = bridge;

		const intruder = expectErr(
			await as('intruder')(() => openFolder({ id: 'notes', definition })),
		);
		const unknown = expectErr(
			await a(() => openFolder({ id: 'elsewhere', definition })),
		);
		const folder = expectOk(
			await a(() => openFolder({ id: 'notes', definition })),
		);

		expect(intruder.name).toBe('WindowNotPermitted');
		expect(unknown).toMatchObject({ name: 'UnknownScope', scope: 'elsewhere' });
		expect(folder.location).toEqual({ kind: 'directory', root });
		expect(folder.git.snapshot.branch).toBe('main');
		// Opening awaits discovery publication and makes no commit.
		expect(folder.git.snapshot.activity.commit).toEqual({ active: false });
		expect(folder.git.snapshot.lastCommit).toBeUndefined();

		// A page built for the previous protocol is refused by the real owner.
		const { error: refusal } = await a(() =>
			commands.attach('notes', FOLDER_PROTOCOL - 1),
		);
		expect(refusal).toEqual({
			name: 'Incompatible',
			host: FOLDER_PROTOCOL,
			page: FOLDER_PROTOCOL - 1,
		});
	});

	test('audio and its row are two saves that make no commit, and each capture is what it reads back', async () => {
		const { folder, todos, root } = await setup();
		const statuses: (string | undefined)[] = [];
		folder.git.subscribe((snapshot) =>
			statuses.push(snapshot.lastCommit?.status),
		);

		const image = expectOk(
			await a(() => folder.files.create('todos/take.png', IMAGE)),
		);
		const created = expectOk(await a(() => todos.create(...row('take'))));
		expect(folder.git.snapshot.lastCommit).toBeUndefined();
		expect(await git(root, 'status', '--porcelain')).toBe(
			'?? epicenter.json\n?? todos/',
		);

		expect(await a(() => folder.git.commit())).toMatchObject({
			status: 'committed',
			message: 'Update 3 files',
		});
		expect(await git(root, 'log', '--format=%s')).toBe('Update 3 files');
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'epicenter.json\ntodos/take.md\ntodos/take.png',
		);
		expect(statuses.at(-1)).toBe('committed');
		expect(expectOk(await a(() => folder.git.status())).changes).toEqual([]);
		// Each save's capture is the version the owner now reads back.
		const reread = expectOk(await a(() => todos.get('take')));
		if (reread === undefined) throw new Error('the row is missing');
		expect(reread.sha256).toEqual(created.sha256);
		const read = expectOk(await a(() => folder.files.read('todos/take.png')));
		expect(read.sha256).toEqual(image.sha256);
		expect(image.sha256).toEqual(await hashBytes(IMAGE));

		// Deleting the row leaves the image: the owner removes one file.
		expectOk(await a(() => todos.delete(reread)));
		expect(
			expectOk(await a(() => folder.files.children('todos'))).files,
		).toEqual(['take.png']);
		const log = expectOk(await a(() => folder.git.log(5)));
		expect(log[0]?.author.name).toBe('Test Author');
		expect(await a(() => folder.git.push())).toEqual({ status: 'noRemote' });
		expect(expectErr(await a(() => folder.git.fetch())).name).toBe('NoRemote');
		// Staging is always available.
		expectOk(await a(() => folder.git.stage('all')));
	});

	test('raw bytes round-trip exactly and the returned sha256 is the content hash', async () => {
		const { folder, other } = await setup();
		const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 256);

		const created = expectOk(
			await a(() => folder.files.create('audio/take.wav', bytes)),
		);
		const read = expectOk(await b(() => other.files.read('audio/take.wav')));

		expect(created).toEqual({
			path: 'audio/take.wav',
			sha256: await hashBytes(bytes),
		});
		expect(read.sha256).toEqual(created.sha256);
		expect(read.bytes).toEqual(bytes);
		expect(
			expectErr(await a(() => folder.files.overwrite('../outside.md', 'x')))
				.name,
		).toBe('InvalidPath');
	});

	test('a capture stays the bytes that were saved while another window replaces the file', async () => {
		const { folder, other } = await setup();
		const mine = expectOk(await a(() => folder.files.create('a.md', 'mine')));
		const theirs = expectOk(
			await b(() => other.files.overwrite('a.md', 'theirs')),
		);

		// The save's capture did not follow the file. It is still the save.
		expect(mine.sha256).toEqual(await hashBytes(encoder.encode('mine')));
		const stale = expectErr(
			await a(() => folder.files.replace(mine, 'built on mine')),
		);
		expect(stale.name).toBe('Conflict');
		if (stale.name === 'Conflict')
			expect(stale.actualSha256).toEqual(theirs.sha256);
		expect(expectErr(await a(() => folder.files.remove(mine))).name).toBe(
			'Conflict',
		);
		expect(expectErr(await a(() => folder.files.move(mine, 'b.md'))).name).toBe(
			'Conflict',
		);

		// A read is the new observation, and a save built on it lands.
		const observed = expectOk(await a(() => folder.files.read('a.md')));
		expect(decoder.decode(observed.bytes)).toBe('theirs');
		const next = expectOk(
			await a(() => folder.files.replace(observed, 'built on theirs')),
		);
		expect(expectOk(await b(() => other.files.read('a.md'))).sha256).toEqual(
			next.sha256,
		);
	});

	test('two windows saving over one version: one lands and one conflicts', async () => {
		const { folder, other } = await setup();
		const base = expectOk(await a(() => folder.files.create('a.md', 'base')));

		const results = await Promise.all([
			a(() => folder.files.replace(base, 'from a')),
			b(() => other.files.replace(base, 'from b')),
		]);

		expect(results.filter((result) => result.error === null)).toHaveLength(1);
		const lost = results.find((result) => result.error !== null)?.error;
		expect(lost?.name).toBe('Conflict');
		const now = expectOk(await a(() => folder.files.read('a.md')));
		expect(['from a', 'from b']).toContain(decoder.decode(now.bytes));
		if (lost?.name === 'Conflict')
			expect(lost.actualSha256).toEqual(now.sha256);
	});

	test('a row another window changed after this window captured it is an exact-sha256 conflict', async () => {
		const { folder, todos, other, files } = await setup();
		expectOk(await a(() => folder.files.create('todos/take.png', IMAGE)));
		const entry = expectOk(await a(() => todos.create(...row('take'))));
		const changed = '---\ntitle: Changed\ndone: true\n---\n';
		// Window B saves over the row after window A captured it.
		await b(async () => {
			expectOk(await other.files.overwrite('todos/take.md', changed));
		});

		// The rename moves the row under the sha256 the entry captured.
		const refused = expectErr(await a(() => todos.rename(entry, 'next')));

		expect(refused.name).toBe('Conflict');
		if (refused.name !== 'Conflict') return;
		expect(refused.path).toBe('todos/take.md');
		expect(refused.expectedSha256).toEqual(entry.sha256);
		expect(refused.actualSha256).toEqual(
			await hashBytes(encoder.encode(changed)),
		);
		expect(await files()).toEqual(['take.md', 'take.png']);
	});

	test('a terminal command holds nothing: another window saves and runs its own terminal between its steps', async () => {
		const { folder, other, root } = await setup();
		const terminal = folder.terminal();
		// Window A's command is stopped mid-run, inside its first listing.
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		active().afterListing = () => {
			reached.resolve();
			return release.promise;
		};
		const command = a(() =>
			terminal.exec('mkdir notes && echo "from the terminal" > notes/a.md'),
		);
		await reached.promise;

		// Window B does not wait for it: a save lands, B commits it, and a
		// whole terminal command of B's own runs to its end.
		expectOk(await b(() => other.files.create('from-b.md', 'did not wait')));
		expect(await b(() => other.git.commit())).toMatchObject({
			status: 'committed',
			message: 'Update 2 files',
		});
		const theirs = await b(() =>
			other.terminal().exec('echo "b ran" > b.md && cat b.md'),
		);
		expect(theirs).toEqual({ stdout: 'b ran\n', stderr: '', exitCode: 0 });
		const before = await git(root, 'rev-parse', 'HEAD');

		release.resolve();
		expect(await command).toEqual({ stdout: '', stderr: '', exitCode: 0 });
		expect(
			decoder.decode(
				expectOk(await a(() => folder.files.read('notes/a.md'))).bytes,
			),
		).toBe('from the terminal\n');

		// A terminal's save makes no commit, like any other save. The next
		// commit records every write that landed since B's.
		expect(await git(root, 'rev-parse', 'HEAD')).toBe(before);
		expect((await a(() => folder.git.commit())).status).toBe('committed');
		const tracked = await git(root, 'ls-tree', '-r', '--name-only', 'HEAD');
		expect(tracked.split('\n')).toEqual(
			expect.arrayContaining(['b.md', 'from-b.md', 'notes/a.md']),
		);
		expect(await git(root, 'status', '--porcelain')).toBe('');
		expect(await git(root, 'show', 'HEAD:notes/a.md')).toBe(
			'from the terminal',
		);
	});

	test('the terminal preserves binary pipelines and moves a directory tree through the real owner', async () => {
		const { folder, other } = await setup();
		const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
		expectOk(await a(() => folder.files.create('raw.bin', bytes)));
		const result = await a(() =>
			folder
				.terminal()
				.exec(
					'mkdir -p source/empty/deep && cat raw.bin | tee source/a.bin >/dev/null && cp source/a.bin source/b.bin && mv source moved',
				),
		);
		expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
		for (const path of ['moved/a.bin', 'moved/b.bin'])
			expect(expectOk(await b(() => other.files.read(path))).bytes).toEqual(
				bytes,
			);
		const listing = expectOk(await b(() => other.files.list()));
		expect(listing.directories).toContain('moved/empty/deep');
		expect(listing.directories).not.toContain('source');
	});

	test('a terminal rewrite of a file it read is refused when another window wrote between its steps', async () => {
		const { folder, other, root } = await setup();
		expectOk(await a(() => folder.files.create('note.md', 'first\n')));
		const terminal = folder.terminal();
		const running = active();
		// After the command has read the file and made its directory, window B
		// replaces the file. The command's next step is its rewrite.
		const interleave = async () => {
			if (!existsSync(join(root, 'made'))) {
				running.afterListing = interleave;
				return;
			}
			await b(async () => {
				expectOk(await other.files.overwrite('note.md', 'from window b\n'));
			});
		};
		running.afterListing = interleave;

		const refused = await failure(
			a(() =>
				terminal.exec(
					'cat note.md && mkdir made && echo replaced > note.md && echo late > late.md',
				),
			),
		);

		// The rewrite named the sha256 the command read, and the owner
		// refused it. Nothing was merged or retried.
		expect(refused).toContain(
			"The file at 'note.md' does not match the captured SHA-256",
		);
		expect(
			decoder.decode(
				expectOk(await a(() => folder.files.read('note.md'))).bytes,
			),
		).toBe('from window b\n');
		// The step before it landed and stays; the step after it never ran.
		expect(existsSync(join(root, 'made'))).toBe(true);
		expect(existsSync(join(root, 'late.md'))).toBe(false);
		// A command that reads again builds on what is there now.
		expect(
			(await a(() => terminal.exec('cat note.md && echo next > note.md')))
				.exitCode,
		).toBe(0);
		expect(
			decoder.decode(
				expectOk(await b(() => other.files.read('note.md'))).bytes,
			),
		).toBe('next\n');
	});

	test('a terminal fetch in flight at the remote holds no save and no commit back', async () => {
		const remote = await HeldRemote.start();
		try {
			const { folder, other, root } = await setup({ remote: remote.url });
			const terminal = folder.terminal();

			// The owner starts a real `git fetch`, and the remote does not answer.
			const fetching = a(() => terminal.exec('git fetch'));
			await remote.arrived;

			// With that transport in flight, both windows save and commit, and
			// other explicit Git work runs.
			expectOk(await b(() => other.files.create('from-b.md', 'did not wait')));
			expect((await b(() => other.git.commit())).status).toBe('committed');
			expect(await git(root, 'log', '--format=%s')).toBe('Update 2 files');
			expectOk(await a(() => folder.files.create('from-a.md', 'nor did this')));
			expect((await a(() => folder.git.commit())).status).toBe('committed');
			expect((await git(root, 'log', '--format=%s')).split('\n')[0]).toBe(
				'Add from-a.md',
			);
			expect(expectOk(await a(() => folder.git.status())).changes).toEqual([]);
			expect(remote.answered()).toBe(0);
			let settledEarly = false;
			void fetching.then(() => {
				settledEarly = true;
			});
			await Bun.sleep(50);
			expect(settledEarly).toBe(false);

			// The remote answers, and the fetch brings in its commit.
			remote.release();
			const fetched = await fetching;
			expect(fetched.exitCode).toBe(0);
			expect(fetched.stdout).toContain(remote.head.slice(0, 7));
			expect(await git(root, 'rev-parse', 'refs/remotes/origin/main')).toBe(
				remote.head,
			);
		} finally {
			remote.release();
			await bridge?.stop();
			bridge = undefined;
			await remote.stop();
		}
	});

	test('red against green is refused and writes nothing, and a merge begun with Git outside blocks history work', async () => {
		const remoteRoot = await realpath(await scratch('tauri-folder-merge-'));
		try {
			const bare = await createBareRemote(remoteRoot);
			const { folder, other, root } = await setup({ remote: bare });
			expectOk(await a(() => folder.files.create('notes/color.txt', 'blue\n')));
			const pushed = await a(() => folder.git.commitAndPush());
			expect(pushed.push.status).toBe('pushed');

			// Another copy makes it green and pushes; this one makes it red.
			const upstream = join(remoteRoot, 'upstream');
			await git(remoteRoot, 'clone', '--quiet', bare, upstream);
			await writeFile(join(upstream, 'notes/color.txt'), 'green\n');
			await git(upstream, 'commit', '--quiet', '-am', 'Green');
			await git(upstream, 'push', '--quiet', 'origin', 'main');
			const green = await git(bare, 'rev-parse', 'main');
			expectOk(
				await a(() => folder.files.overwrite('notes/color.txt', 'red\n')),
			);
			const red = await a(() => folder.git.commit());
			if (red.status !== 'committed') throw new Error(red.status);
			expectOk(await a(() => folder.git.fetch()));
			const index = await readFile(join(root, '.git/index'));

			// The conflict is refused: no marker, stage, ref, or merge state.
			const terminal = folder.terminal();
			const merged = await a(() => terminal.exec('git merge'));
			expect(merged.exitCode).toBe(1);
			expect(merged.stderr).toContain(
				'CONFLICT (content): Merge conflict in notes/color.txt',
			);
			expect(expectErr(await b(() => other.git.mergeIncoming()))).toMatchObject(
				{
					name: 'Conflicted',
					conflicts: [{ reason: 'content', path: 'notes/color.txt' }],
				},
			);
			expect(await readFile(join(root, 'notes/color.txt'), 'utf8')).toBe(
				'red\n',
			);
			expect(await readFile(join(root, '.git/index'))).toEqual(index);
			expect(await git(root, 'status', '--porcelain')).toBe('');
			expect(await git(root, 'rev-parse', 'main')).toBe(red.oid);
			expect(existsSync(join(root, '.git/MERGE_HEAD'))).toBe(false);
			expect(existsSync(join(root, '.git/ORIG_HEAD'))).toBe(false);

			// The person's own Git merges and stops on the conflict.
			await expect(
				git(root, 'merge', '--no-edit', 'origin/main'),
			).rejects.toThrow();
			expect(existsSync(join(root, '.git/MERGE_HEAD'))).toBe(true);
			const blocked =
				'a Git merge is in progress; finish or abort it with Git outside Epicenter';
			const committed = await a(() => folder.git.commit());
			expect(committed).toMatchObject({ status: 'blocked' });
			if (committed.status !== 'blocked') throw new Error(committed.status);
			expect(committed.reason).toContain(blocked);
			const staged = expectErr(await b(() => other.git.commitStaged('Merge')));
			expect(staged.name).toBe('Failed');
			expect(staged.message).toContain(blocked);
			expect(
				expectErr(await a(() => folder.git.mergeIncoming())),
			).toMatchObject({ name: 'Blocked' });
			expect(await git(root, 'rev-parse', 'main')).toBe(red.oid);
			expect(await git(root, 'rev-parse', 'MERGE_HEAD')).toBe(green);
		} finally {
			await bridge?.stop();
			bridge = undefined;
			await rm(remoteRoot, { recursive: true, force: true });
		}
	});

	test('close detaches before a landed native save replies, and that save returns success', async () => {
		const { folder, other } = await setup();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		active().afterApply = async () => {
			reached.resolve();
			await release.promise;
		};
		const saving = a(() => folder.files.create('late-reply.txt', 'landed'));
		await reached.promise;
		await a(() => folder.close());
		const { error: detached } = await a(() => commands.list(1));
		expect(detached?.name).toBe('Denied');
		release.resolve();
		expectOk(await saving);
		const current = expectOk(await b(() => other.files.read('late-reply.txt')));
		expect(decoder.decode(current.bytes)).toBe('landed');
	});

	test('a save the shell receives after its session saved again lands last and stays', async () => {
		const { folder, other } = await setup();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		// The earlier save is held before Rust receives it.
		active().beforeApply = async () => {
			reached.resolve();
			await release.promise;
		};
		const earlier = a(() => folder.files.overwrite('order.md', 'earlier'));
		await reached.promise;
		// The later save reaches the owner first and lands; the earlier one
		// then lands over it.
		expectOk(await a(() => folder.files.overwrite('order.md', 'later')));
		release.resolve();
		expectOk(await earlier);
		const current = expectOk(await b(() => other.files.read('order.md')));
		expect(decoder.decode(current.bytes)).toBe('earlier');
	});

	/** Hold the next SHA-256 digest until released, where a slow hash leaves a save. */
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
		return {
			reached: reached.promise,
			release() {
				released.resolve();
				spy.mockRestore();
			},
		};
	}

	test('a save still hashing when a later save of the page lands, lands after it, through one handle or two', async () => {
		const { folder, other } = await setup();
		const second = await a(async () =>
			expectOk(await openFolder({ id: 'notes', definition })),
		);
		for (const [label, later] of [
			['one handle', folder],
			['two handles', second],
		] as const) {
			const path = `hashing-${label.replace(' ', '-')}.md`;
			const digest = holdNextDigest();
			const earlier = a(() => folder.files.overwrite(path, 'earlier'));
			await digest.reached;
			expectOk(await a(() => later.files.overwrite(path, 'later')));
			digest.release();
			expectOk(await earlier);
			const current = expectOk(await b(() => other.files.read(path)));
			expect(decoder.decode(current.bytes)).toBe('earlier');
		}
		await a(() => second.close());
	});

	test('a table replace still hashing when a raw save lands is refused, and the raw save stays', async () => {
		const { folder, other } = await setup();
		const created = expectOk(
			await a(() =>
				folder.tables.todos.create(
					{ fields: { title: 'Plan', done: false }, body: '' },
					{ stem: 'plan' },
				),
			),
		);
		const digest = holdNextDigest();
		const replacing = a(() =>
			folder.tables.todos.replace(created, {
				fields: { title: 'Edited', done: false },
				body: '',
			}),
		);
		await digest.reached;
		expectOk(await a(() => folder.files.overwrite(created.path, 'raw')));
		digest.release();
		// The replace names the bytes it captured, which the raw save replaced.
		const refused = expectErr(await replacing);
		expect(refused.name).toBe('Conflict');
		const current = expectOk(await b(() => other.files.read(created.path)));
		expect(decoder.decode(current.bytes)).toBe('raw');
	});

	test('an apply delivered after detach returns the owner refusal without writing or replay', async () => {
		const { folder, other } = await setup();
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		active().beforeApply = async () => {
			reached.resolve();
			await release.promise;
		};
		const saving = a(() =>
			folder.files.create('after-detach.txt', 'not delivered yet'),
		);
		await reached.promise;
		await a(() => folder.close());
		release.resolve();
		expect(expectErr(await saving).name).toBe('Io');
		expect(
			expectErr(await b(() => other.files.read('after-detach.txt'))).name,
		).toBe('NotFound');
	});

	test('closing a page mid-command stops its later steps; the save already admitted lands, and closing commits nothing', async () => {
		const { folder, other, root } = await setup();
		const terminal = folder.terminal();
		const running = active();
		// Close window A's folder once the command's first file has landed,
		// from inside the listing that follows that save.
		let closing: Promise<void> | undefined;
		const closeAfterFirstSave = async () => {
			if (!existsSync(join(root, 'one.md'))) {
				running.afterListing = closeAfterFirstSave;
				return;
			}
			// Closing fences the next step without waiting for this listing.
			closing = a(() => folder.close());
		};
		running.afterListing = closeAfterFirstSave;

		const stopped = await failure(
			a(() => terminal.exec('echo one > one.md && echo two > two.md')),
		);
		await closing;

		expect(stopped).toMatch(/The folder is closed|execution aborted/);
		// The save the owner had admitted is in the folder; nothing after it is.
		expect(existsSync(join(root, 'one.md'))).toBe(true);
		expect(existsSync(join(root, 'two.md'))).toBe(false);
		expect(await a(() => terminal.exec('echo late > late.md'))).toEqual({
			stdout: '',
			stderr: 'The folder is closed\n',
			exitCode: 1,
		});
		expect(existsSync(join(root, 'late.md'))).toBe(false);

		// Closing committed nothing, and window B carries on: its commit
		// records the save the page left.
		expect(await git(root, 'status', '--porcelain')).toBe(
			'?? epicenter.json\n?? one.md',
		);
		expectOk(await b(() => other.files.create('after.md', 'b carries on')));
		expect((await b(() => other.git.commit())).status).toBe('committed');
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'after.md\nepicenter.json\none.md',
		);
	});

	test('closing one window leaves the other, and its last save stays for the next commit', async () => {
		const { folder, other, root } = await setup();
		const heard: (readonly string[])[] = [];
		other.onFilesChanged((paths) => heard.push(paths));

		// The page saves and closes at once.
		expectOk(
			await a(() => folder.files.create('last.md', 'saved as the page closed')),
		);
		await a(() => folder.close());

		expect(expectErr(await a(() => folder.files.read('last.md'))).name).toBe(
			'Closed',
		);
		// The owner itself no longer knows window A's session.
		const { error: unknownSession } = await a(() => commands.list(1));
		expect(unknownSession?.name).toBe('Denied');

		// Closing committed nothing: the save is in the folder, uncommitted.
		expect(await git(root, 'status', '--porcelain')).toBe(
			'?? epicenter.json\n?? last.md',
		);

		expectOk(
			await b(() => other.files.create('after.md', 'window b carries on')),
		);
		expect((await b(() => other.git.commit())).status).toBe('committed');
		expect(await git(root, 'ls-tree', '-r', '--name-only', 'HEAD')).toBe(
			'after.md\nepicenter.json\nlast.md',
		);
		expect(heard.flat()).toEqual(
			expect.arrayContaining(['last.md', 'after.md']),
		);
		expect(other.git.snapshot.closed).toBe(false);
	});
});
