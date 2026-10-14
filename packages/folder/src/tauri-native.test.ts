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
 * - A merge of red against green is refused and writes
 *   nothing; a merge the person's own Git begins blocks commits, staged
 *   commits, and merges until Git outside Epicenter finishes it
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
import { createBareRemote, git, scratch } from './git-http.test-support.js';

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
