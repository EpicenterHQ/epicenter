/**
 * The sync scenarios, as runs any world calls: two computers syncing
 * through one repository with `sync` (ADR-0803). They port the scenarios
 * of the CLI's `sync.e2e.test.ts` and the core's `tests/round.rs` to the
 * store contract, with no Git on the client. `sync.test.ts` runs them over
 * memory stores and a memory repository; `sync.postgres.test.ts` over
 * directories and the server's repository.
 *
 * - First contact puts both sides' files on both; two creates of one note merge.
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
import { type ManifestStore, sync } from './sync.js';

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
	return expectOk(await sync({ local, remote, manifest: device.manifest }));
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
			write(next) {
				saves++;
				return a.manifest.write(next);
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
		expect(report).toMatchObject({
			outcome: 'synced',
			passes: 2,
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
			async write(path, bytes, over) {
				if (path === 'todos/a.md') await a.write(path, agent);
				return a.store.write(path, bytes, over);
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
			async write(manifest) {
				if (++saves === 2)
					return ClientError.Unavailable({ cause: 'disk full' });
				return a.manifest.write(manifest);
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
};
