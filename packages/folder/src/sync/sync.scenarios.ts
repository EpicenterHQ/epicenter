/**
 * The sync scenarios, as runs any world calls: two computers syncing
 * through one repository with `sync` (ADR-0803). They port the scenarios
 * of the CLI's `sync.e2e.test.ts` and the core's `tests/round.rs` to the
 * store contract, with no Git on the client. `sync.test.ts` runs them over
 * memory stores and a memory repository; `sync.postgres.test.ts` over
 * directories and the server's repository.
 *
 * - First contact puts both sides' files on both; two creates of one note merge.
 * - Every visible file syncs, the contract's or not; a hidden one never does.
 * - A path differing only in case from one the repository holds is refused
 *   and reported, and stays on its computer.
 * - An unchanged sync reads no file and saves no manifest.
 * - Fields merge by key: different fields both land, one field takes the later sync's.
 * - A body merges by lines; a clash is one block of Git's markers.
 * - An edit beats a delete; an attachment both replaced takes the later sync's.
 * - A repository that moves during a sync costs a pass, never a write.
 * - A file another program writes during a sync is kept and merged next time.
 * - A sync stopped anywhere converges on rerun, with no doubled markers.
 */
import { expect } from 'bun:test';
import { ClientError } from '@epicenter/definition/contract';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { Store } from '../device/store.js';
import type { Repository } from './repository.js';
import { MANIFEST_PATH, type ManifestStore, sync } from './sync.js';

/** One computer: its store and manifest, and its files as another program writes and reads them. */
export type Device = {
	store: Store;
	manifest: ManifestStore;
	write(path: string, content: string | Uint8Array | null): Promise<void>;
	read(path: string): Promise<string | null>;
	/** Every visible file's path, sorted. */
	paths(): Promise<string[]>;
};

/** A repository, and a way to make the computers that sync with it. */
export type World = { repository: Repository; device(): Promise<Device> };

const note = (fields: string, body = '') => `---\n${fields}---\n${body}`;
const todo = note(
	'title: "Call dentist"\ndone: false\n',
	'Ask about Thursday.\n',
);

/** Sync `device`, through `remote` and `local` standing in for its own where given. */
async function syncOf(
	world: World,
	device: Device,
	{
		local = device.store,
		remote = world.repository,
	}: { local?: Store; remote?: Repository } = {},
) {
	const report = expectOk(
		await sync({ local, remote, manifest: device.manifest }),
	);
	// A completed sync that kept nothing agrees at one commit: no file has a base of its own.
	if (report.outcome === 'synced' && report.kept.length === 0)
		expect(expectOk(await device.manifest.read()).manifest.at).toBeUndefined();
	return report;
}

/** Every visible file's text, by path. */
async function contents(device: Device) {
	const out: Record<string, string | null> = {};
	for (const path of await device.paths()) out[path] = await device.read(path);
	return out;
}

const markers = (text: string | null) =>
	(text ?? '').split('<<<<<<< ').length - 1;

/** Two computers synced to each other, holding `text` at `path`. */
async function synced(world: World, path = 'todos/a.md', text = todo) {
	const a = await world.device();
	const b = await world.device();
	await a.write(path, text);
	await syncOf(world, a);
	await syncOf(world, b);
	await syncOf(world, a);
	expect(await b.read(path)).toBe(text);
	return { a, b };
}

/**
 * Two syncs of one computer at once, after both computers changed one
 * note's line and each added files: the sync started `held` saves its
 * manifest only once the other has finished, so the other's save lands
 * first. Both answer `synced`, and then both computers hold every file and
 * one conflict block.
 */
async function twoSyncsAtOnce(world: World, held: 'first' | 'second') {
	const text = note('title: "A"\n', 'one\ntwo\nthree\n');
	const { a, b } = await synced(world, 'todos/a.md', text);
	await b.write('todos/a.md', text.replace('two', 'from B'));
	await b.write('todos/b.md', note('title: "B"\n'));
	await syncOf(world, b);
	await a.write('todos/a.md', text.replace('two', 'from A'));
	await a.write('todos/new.md', note('title: "New"\n'));
	await a.write('audio/r.webm', 'recorded on A');

	let finished = () => {};
	const otherFinished = new Promise<void>((resolve) => {
		finished = resolve;
	});
	const waiting: ManifestStore = {
		read: () => a.manifest.read(),
		async write(manifest, over) {
			await otherFinished;
			return a.manifest.write(manifest, over);
		},
	};
	const run = (manifest: ManifestStore) =>
		sync({ local: a.store, remote: world.repository, manifest });
	const reports =
		held === 'first'
			? await Promise.all([
					run(waiting),
					run(a.manifest).finally(() => finished()),
				])
			: await Promise.all([
					run(a.manifest).finally(() => finished()),
					run(waiting),
				]);
	const [waited, ran] = (held === 'first' ? reports : reports.reverse()).map(
		(report) => expectOk(report),
	);
	expect(ran?.outcome).toBe('synced');
	// Its first save found the other's: it ran again from that.
	expect(waited).toMatchObject({ outcome: 'synced' });
	expect(waited?.passes).toBeGreaterThan(1);

	await syncOf(world, b);
	await syncOf(world, a);
	await syncOf(world, b);
	expect(await contents(b)).toEqual(await contents(a));
	expect(await a.paths()).toEqual([
		'audio/r.webm',
		'todos/a.md',
		'todos/b.md',
		'todos/new.md',
	]);
	expect(await b.read('audio/r.webm')).toBe('recorded on A');
	const merged = await a.read('todos/a.md');
	expect(markers(merged)).toBe(1);
	expect(merged).toContain('from A');
	expect(merged).toContain('from B');
}

export const syncScenarios: Record<string, (world: World) => Promise<void>> = {
	async 'first contact: both sides get every file, and two creates of one note merge'(
		world,
	) {
		const a = await world.device();
		const b = await world.device();
		await b.write('todos/b.md', note('title: "B"\n'));
		await b.write(
			'todos/same.md',
			note('title: "From B"\ntags: []\n', 'B wrote this.\n'),
		);
		expect((await syncOf(world, b)).pushed).toEqual([
			'todos/b.md',
			'todos/same.md',
		]);
		await a.write('todos/a.md', note('title: "A"\n'));
		await a.write(
			'todos/same.md',
			note('title: "From A"\ndone: false\n', 'A wrote this.\n'),
		);
		await a.write('audio/a.webm', new Uint8Array([1, 2, 3]));

		const first = await syncOf(world, a);
		expect(first.merged).toEqual(['todos/same.md']);
		expect(first.pulled).toEqual(['todos/b.md']);
		expect(await a.read('todos/same.md')).toBe(
			note(
				'done: false\ntags: []\ntitle: "From A"\n',
				'<<<<<<< current\nA wrote this.\n=======\nB wrote this.\n>>>>>>> incoming\n',
			),
		);
		await syncOf(world, b);
		expect(await contents(b)).toEqual(await contents(a));
		expect(await a.paths()).toEqual([
			'audio/a.webm',
			'todos/a.md',
			'todos/b.md',
			'todos/same.md',
		]);
	},

	async 'a file outside the contract syncs both ways: AGENTS.md and a person’s own files'(
		world,
	) {
		const a = await world.device();
		const b = await world.device();
		await a.write('AGENTS.md', '# Todos\n\nKeep it short.\n');
		await a.write('mine/plan.txt', 'draft');
		await a.write('mine/photo.jpg', new Uint8Array([0xff, 0xd8, 0xff]));
		await syncOf(world, a);
		expect((await syncOf(world, b)).pulled).toEqual([
			'AGENTS.md',
			'mine/photo.jpg',
			'mine/plan.txt',
		]);
		await b.write('AGENTS.md', '# Todos\n\nKeep it shorter.\n');
		await b.write('mine/plan.txt', 'draft, edited');
		await b.write('mine/photo.jpg', null);
		await syncOf(world, b);
		await syncOf(world, a);
		expect(await contents(a)).toEqual({
			'AGENTS.md': '# Todos\n\nKeep it shorter.\n',
			'mine/plan.txt': 'draft, edited',
		});
		expect(await contents(b)).toEqual(await contents(a));
	},

	async 'a hidden file never syncs, in either direction'(world) {
		const a = await world.device();
		const b = await world.device();
		await a.write('todos/a.md', todo);
		await a.write('.notes/secret.md', 'only on A');
		await a.write('todos/.draft.md', 'only on A');
		await b.write('.notes/secret.md', 'only on B');
		await syncOf(world, a);
		await syncOf(world, b);
		await syncOf(world, a);
		const held = expectOk(await world.repository.snapshot()).files.map(
			({ path }) => path,
		);
		expect(held).toContain('todos/a.md');
		expect(
			held.filter((path) => path.includes('secret') || path.includes('draft')),
		).toEqual([]);
		expect(await b.read('todos/.draft.md')).toBeNull();
		expect(await a.read('.notes/secret.md')).toBe('only on A');
		expect(await b.read('.notes/secret.md')).toBe('only on B');
	},

	async 'a path differing only in case from one the repository holds is refused, reported, and kept'(
		world,
	) {
		const a = await world.device();
		const b = await world.device();
		await a.write('todos/a.md', todo);
		await syncOf(world, a);
		const mine = note('title: "Mine"\n');
		await b.write('todos/A.md', mine);
		await b.write('todos/b.md', note('title: "B"\n'));
		const report = await syncOf(world, b);
		expect(report).toMatchObject({
			outcome: 'synced',
			pushed: ['todos/b.md'],
			refused: [
				{
					path: 'todos/A.md',
					reason: expect.stringContaining('differs only in case'),
				},
			],
		});
		expect(await b.read('todos/A.md')).toBe(mine);
		// Refused again by the next sync, never dropped.
		expect((await syncOf(world, b)).refused.map(({ path }) => path)).toEqual([
			'todos/A.md',
		]);
		await syncOf(world, a);
		expect(await a.paths()).toEqual(['todos/a.md', 'todos/b.md']);
		expect(await a.read('todos/a.md')).toBe(todo);
	},

	async 'an unchanged sync reads no file and saves no manifest'(world) {
		const { a } = await synced(world);
		let reads = 0;
		let saves = 0;
		const remote: Repository = {
			...world.repository,
			readAt(...args) {
				reads++;
				return world.repository.readAt(...args);
			},
		};
		const manifest: ManifestStore = {
			read: () => a.manifest.read(),
			write(next, over) {
				saves++;
				return a.manifest.write(next, over);
			},
		};
		const again = expectOk(await sync({ local: a.store, remote, manifest }));
		expect(again).toMatchObject({
			outcome: 'synced',
			pulled: [],
			pushed: [],
			merged: [],
		});
		expect({ reads, saves }).toEqual({ reads: 0, saves: 0 });
	},

	async 'different fields changed on each side: both land'(world) {
		const { a, b } = await synced(world);
		await a.write('todos/a.md', todo.replace('done: false', 'done: true'));
		await b.write(
			'todos/a.md',
			todo.replace('"Call dentist"', '"Call the dentist"'),
		);
		await syncOf(world, a);
		expect((await syncOf(world, b)).merged).toEqual(['todos/a.md']);
		await syncOf(world, a);
		const merged = note(
			'title: "Call the dentist"\ndone: true\n',
			'Ask about Thursday.\n',
		);
		expect(await a.read('todos/a.md')).toBe(merged);
		expect(await b.read('todos/a.md')).toBe(merged);
	},

	async 'one field changed on both sides: the later sync wins'(world) {
		const { a, b } = await synced(world);
		await a.write('todos/a.md', todo.replace('"Call dentist"', '"From A"'));
		await b.write('todos/a.md', todo.replace('"Call dentist"', '"From B"'));
		await syncOf(world, a);
		await syncOf(world, b);
		await syncOf(world, a);
		expect(await a.read('todos/a.md')).toContain('title: "From B"');
		expect(await contents(a)).toEqual(await contents(b));
	},

	async 'a body edited at different spots: both land, no markers'(world) {
		const text = note('title: "A"\n', 'one\ntwo\nthree\nfour\nfive\n');
		const { a, b } = await synced(world, 'todos/a.md', text);
		await a.write('todos/a.md', text.replace('one', 'ONE'));
		await b.write('todos/a.md', text.replace('five', 'FIVE'));
		await syncOf(world, a);
		expect((await syncOf(world, b)).conflicts).toEqual([]);
		await syncOf(world, a);
		expect(await a.read('todos/a.md')).toBe(
			note('title: "A"\n', 'ONE\ntwo\nthree\nfour\nFIVE\n'),
		);
		expect(await contents(a)).toEqual(await contents(b));
	},

	async 'a body edited at one spot: one conflict block, the syncing computer as current'(
		world,
	) {
		const text = note('title: "A"\n', 'one\ntwo\nthree\n');
		const { a, b } = await synced(world, 'todos/a.md', text);
		await a.write('todos/a.md', text.replace('two', 'from A'));
		await b.write('todos/a.md', text.replace('two', 'from B'));
		await syncOf(world, a);
		expect((await syncOf(world, b)).conflicts).toEqual(['todos/a.md']);
		await syncOf(world, a);
		const merged = note(
			'title: "A"\n',
			'one\n<<<<<<< current\nfrom B\n=======\nfrom A\n>>>>>>> incoming\nthree\n',
		);
		expect(await a.read('todos/a.md')).toBe(merged);
		expect(await b.read('todos/a.md')).toBe(merged);
	},

	async 'a delete on one side deletes on the other'(world) {
		const { a, b } = await synced(world);
		await a.write('todos/a.md', null);
		expect((await syncOf(world, a)).pushed).toEqual(['todos/a.md']);
		expect((await syncOf(world, b)).pulled).toEqual(['todos/a.md']);
		expect(await b.paths()).toEqual([]);
	},

	async 'an edit beats a delete, whichever side deleted'(world) {
		const { a, b } = await synced(world);
		await b.write('todos/b.md', note('title: "B"\n'));
		await syncOf(world, b);
		await syncOf(world, a);
		const edited = todo.replace('Thursday', 'Friday');
		await a.write('todos/a.md', null);
		await b.write('todos/a.md', edited);
		await a.write('todos/b.md', note('title: "B, edited"\n'));
		await b.write('todos/b.md', null);
		await syncOf(world, a);
		await syncOf(world, b);
		await syncOf(world, a);
		expect(await contents(a)).toEqual({
			'todos/a.md': edited,
			'todos/b.md': note('title: "B, edited"\n'),
		});
		expect(await contents(b)).toEqual(await contents(a));
	},

	async 'an attachment replaced on both sides takes the later sync'(world) {
		const { a, b } = await synced(world, 'audio/r.webm', 'original');
		await a.write('audio/r.webm', 'from A');
		await b.write('audio/r.webm', 'from B');
		await syncOf(world, a);
		expect((await syncOf(world, b)).pushed).toEqual(['audio/r.webm']);
		await syncOf(world, a);
		expect(await a.read('audio/r.webm')).toBe('from B');
		expect(await b.read('audio/r.webm')).toBe('from B');
	},

	async 'the repository moving during a sync costs a pass and loses nothing'(
		world,
	) {
		const { a, b } = await synced(world);
		await a.write('todos/a.md', todo.replace('done: false', 'done: true'));
		// B lands an edit of the same note, and a new note, after A has read.
		let raced = false;
		const racing: Repository = {
			...world.repository,
			async writeAll(...args) {
				if (!raced) {
					raced = true;
					await b.write('todos/a.md', todo.replace('Thursday', 'Monday'));
					await b.write('todos/new.md', note('title: "New"\n'));
					await syncOf(world, b);
				}
				return world.repository.writeAll(...args);
			},
		};
		const report = await syncOf(world, a, { remote: racing });
		// One pass went stale, one merged and pushed, and one agreed at the head.
		expect(report).toMatchObject({
			outcome: 'synced',
			passes: 3,
			merged: ['todos/a.md'],
		});
		await syncOf(world, b);
		const merged = note(
			'title: "Call dentist"\ndone: true\n',
			'Ask about Monday.\n',
		);
		expect(await contents(a)).toEqual({
			'todos/a.md': merged,
			'todos/new.md': note('title: "New"\n'),
		});
		expect(await contents(b)).toEqual(await contents(a));
	},

	async 'a file another program writes during a sync is kept, and merged by the next'(
		world,
	) {
		const { a, b } = await synced(world);
		await b.write('todos/a.md', todo.replace('Thursday', 'Monday'));
		await syncOf(world, b);
		// An agent changes the note right before A's sync writes it.
		const agent = todo.replace('done: false', 'done: true');
		const local: Store = {
			...a.store,
			async put(path, bytes, expect) {
				if (path === 'todos/a.md') await a.write(path, agent);
				return a.store.put(path, bytes, expect);
			},
		};
		const report = await syncOf(world, a, { local });
		expect(report.kept).toEqual(['todos/a.md']);
		expect(await a.read('todos/a.md')).toBe(agent);
		await syncOf(world, a);
		await syncOf(world, b);
		const merged = note(
			'title: "Call dentist"\ndone: true\n',
			'Ask about Monday.\n',
		);
		expect(await a.read('todos/a.md')).toBe(merged);
		expect(await b.read('todos/a.md')).toBe(merged);
	},

	async 'a sync stopped before its repository write converges on rerun with one conflict block'(
		world,
	) {
		const text = note('title: "A"\n', 'one\ntwo\nthree\n');
		const { a, b } = await synced(world, 'todos/a.md', text);
		await b.write('todos/a.md', text.replace('two', 'from B'));
		await syncOf(world, b);
		await a.write('todos/a.md', text.replace('two', 'from A'));
		const offline: Repository = {
			...world.repository,
			writeAll: async () => ClientError.Unavailable({ cause: 'offline' }),
		};
		expectErr(
			await sync({ local: a.store, remote: offline, manifest: a.manifest }),
		);
		expect(markers(await a.read('todos/a.md'))).toBe(1);
		await syncOf(world, a);
		await syncOf(world, b);
		expect(markers(await a.read('todos/a.md'))).toBe(1);
		expect(await contents(b)).toEqual(await contents(a));
	},

	async 'a sync stopped before saving its manifest converges on rerun with one conflict block'(
		world,
	) {
		const text = note('title: "A"\n', 'one\ntwo\nthree\n');
		const { a, b } = await synced(world, 'todos/a.md', text);
		await b.write('todos/a.md', text.replace('two', 'from B'));
		await syncOf(world, b);
		await a.write('todos/a.md', text.replace('two', 'from A'));
		// The save after the merge lands; the last, after the repository write, fails.
		let saves = 0;
		const failing: ManifestStore = {
			read: () => a.manifest.read(),
			async write(manifest, over) {
				if (++saves === 2)
					return ClientError.Unavailable({ cause: 'disk full' });
				return a.manifest.write(manifest, over);
			},
		};
		expectErr(
			await sync({
				local: a.store,
				remote: world.repository,
				manifest: failing,
			}),
		);
		expect(saves).toBe(2);
		await syncOf(world, a);
		await syncOf(world, b);
		expect(markers(await a.read('todos/a.md'))).toBe(1);
		expect(await contents(b)).toEqual(await contents(a));
	},

	async 'two syncs of one folder at once, the later-started saving first: both land, nothing lost, one conflict block'(
		world,
	) {
		await twoSyncsAtOnce(world, 'first');
	},

	async 'two syncs of one folder at once, the earlier-started saving first: both land, nothing lost, one conflict block'(
		world,
	) {
		await twoSyncsAtOnce(world, 'second');
	},

	async 'a raced local write and a merge in one pass, stopped before the repository write: nothing lost, one conflict block'(
		world,
	) {
		// The sequence that needs a file's own base in the manifest: the
		// save after the merge must record the merged note as agreed at the
		// head, and the kept note at the commit before, at once.
		const text = note('title: "Y"\n', 'one\ntwo\nthree\n');
		const { a, b } = await synced(world, 'todos/y.md', text);
		await a.write('todos/x.md', todo);
		await syncOf(world, a);
		await syncOf(world, b);
		await b.write('todos/x.md', todo.replace('Thursday', 'Monday'));
		await b.write('todos/y.md', text.replace('two', 'from B'));
		await syncOf(world, b);
		await a.write('todos/y.md', text.replace('two', 'from A'));
		// An agent changes x.md right before A's sync pulls it, and A goes offline.
		const agent = todo.replace('done: false', 'done: true');
		const local: Store = {
			...a.store,
			async put(path, bytes, expect) {
				if (path === 'todos/x.md') await a.write(path, agent);
				return a.store.put(path, bytes, expect);
			},
		};
		const offline: Repository = {
			...world.repository,
			writeAll: async () => ClientError.Unavailable({ cause: 'offline' }),
		};
		expectErr(await sync({ local, remote: offline, manifest: a.manifest }));
		expect(await a.read('todos/x.md')).toBe(agent);
		expect(markers(await a.read('todos/y.md'))).toBe(1);

		await syncOf(world, a);
		await syncOf(world, b);
		await syncOf(world, a);
		expect(await contents(b)).toEqual(await contents(a));
		expect(await a.read('todos/x.md')).toBe(
			note('title: "Call dentist"\ndone: true\n', 'Ask about Monday.\n'),
		);
		const y = await a.read('todos/y.md');
		expect(markers(y)).toBe(1);
		expect(y).toContain('from A');
		expect(y).toContain('from B');
	},

	async 'a folder whose manifest is deleted syncs again with no file lost'(
		world,
	) {
		const text = note('title: "A"\n', 'one\ntwo\nthree\n');
		const { a, b } = await synced(world, 'todos/a.md', text);
		await b.write('todos/b.md', note('title: "B"\n'));
		await b.write('audio/r.webm', 'from B');
		await b.write('todos/a.md', text.replace('three', 'three from B'));
		await syncOf(world, b);
		await a.write('todos/a.md', text.replace('one', 'one from A'));
		await a.write('todos/mine.md', note('title: "Mine"\n'));
		await a.write(MANIFEST_PATH, null);

		await syncOf(world, a);
		await syncOf(world, b);
		await syncOf(world, a);
		expect(await contents(b)).toEqual(await contents(a));
		expect(await a.paths()).toEqual([
			'audio/r.webm',
			'todos/a.md',
			'todos/b.md',
			'todos/mine.md',
		]);
		// With no base, the two sides' texts meet as two creates: both are kept.
		const merged = await a.read('todos/a.md');
		expect(merged).toContain('one from A');
		expect(merged).toContain('three from B');
		expect(await a.read('audio/r.webm')).toBe('from B');
	},
};
