import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Err, Ok } from 'wellcrafted/result';
import { ActionError } from './answer.ts';
import { defineData } from './data.ts';
import { field } from './field.ts';

const homes: string[] = [];
afterEach(async () => {
	for (const home of homes.splice(0))
		await rm(home, { recursive: true, force: true });
});

async function tempHome() {
	const home = await mkdtemp(join(tmpdir(), 'epicenter-data-'));
	homes.push(home);
	return home;
}

/** The definitions a home's epicenter.ts would make, at a folder nothing reads. */
const data = defineData('/nowhere/epicenter', {
	watches: {
		description: 'trip idea',
		fields: {
			to: field.text(),
			nights: field.integer({ min: 1, optional: true }),
		},
	},
	checks: {
		description: 'research result',
		fields: { watch: field.ref('watches'), fare: field.number() },
	},
});

test('defining touches no file, and rebinding keeps the type, so an app function takes the rebound data', async () => {
	expect(existsSync('/nowhere/epicenter')).toBe(false);
	const rebound: typeof data = defineData(await tempHome(), data);
	expect(Object.keys(rebound)).toEqual(['watches', 'checks']);
	expect(rebound.checks.fields).toBe(data.checks.fields);
});

test('a rebound handle writes a record as Markdown under data/<key>/<id>.md', async () => {
	const home = await tempHome();
	const { watches } = defineData(home, data);
	const created = await watches.create('tokyo', {
		to: 'Tokyo',
		nights: 5,
		body: 'Late March.\n',
	});
	expect(created).toEqual(
		Ok({
			path: 'data/watches/tokyo.md',
			id: 'tokyo',
			to: 'Tokyo',
			nights: 5,
			body: 'Late March.\n',
		}),
	);
	expect(await readFile(join(home, 'data/watches/tokyo.md'), 'utf8')).toBe(
		'---\nto: "Tokyo"\nnights: 5\n---\nLate March.\n',
	);
	expect((await watches.get('tokyo')).data).toEqual(created.data ?? null);
	expect(await watches.get('osaka')).toEqual(Ok(undefined));
	expect(await watches.delete('tokyo')).toEqual(Ok(true));
	expect(await watches.delete('tokyo')).toEqual(Ok(false));
});

test('patch changes only the lines it names, and null removes an optional field', async () => {
	const home = await tempHome();
	const path = join(home, 'data/watches/tokyo.md');
	await mkdir(join(home, 'data/watches'), { recursive: true });
	await writeFile(
		path,
		'---\nto: "Tokyo"\nnights: 5\nnote: kept as typed\n---\nBody\n',
	);
	const { watches } = defineData(home, data);
	const patched = await watches.patch('tokyo', { nights: null, to: 'Kyoto' });
	expect(patched.error).toBeNull();
	expect(await readFile(path, 'utf8')).toBe(
		'---\nto: "Kyoto"\nnote: kept as typed\n---\nBody\n',
	);
});

test('a read reports each line that does not fit, and the record for repair', async () => {
	const home = await tempHome();
	await mkdir(join(home, 'data/watches'), { recursive: true });
	await writeFile(join(home, 'data/watches/bad.md'), '---\nnights: 0\n---\n');
	const { watches } = defineData(home, data);
	const read = await watches.get('bad');
	expect(read.error?.name).toBe('Misfit');
	expect(read.error?.message).toBe(
		[
			'data/watches/bad.md does not fit its fields:',
			'data/watches/bad.md: to is missing',
			'data/watches/bad.md: nights: 0 is not a whole number of at least 1',
		].join('\n'),
	);
	expect((await watches.list()).map((each) => each.error)).toEqual([
		read.error,
	]);
});

test('a write it refuses writes nothing: a value that does not fit, a record already there, or one missing', async () => {
	const home = await tempHome();
	const { watches } = defineData(home, data);
	const misfit = await watches.create('tokyo', {
		to: 'Tokyo',
		nights: 'five' as unknown as number,
	});
	expect(misfit.error?.name).toBe('Misfit');
	expect(existsSync(join(home, 'data/watches/tokyo.md'))).toBe(false);
	await watches.create('tokyo', { to: 'Tokyo' });
	const before = await readFile(join(home, 'data/watches/tokyo.md'), 'utf8');
	expect((await watches.create('tokyo', { to: 'Kyoto' })).error?.name).toBe(
		'Exists',
	);
	expect((await watches.patch('osaka', { to: 'Osaka' })).error?.name).toBe(
		'Missing',
	);
	expect(await readdir(join(home, 'data/watches'))).toEqual(['tokyo.md']);
	expect(await readFile(join(home, 'data/watches/tokyo.md'), 'utf8')).toBe(
		before,
	);
});

test('edit computes a change from the record, or creates one, and its own Err writes nothing', async () => {
	const { watches } = defineData(await tempHome(), data);
	const made = await watches.edit('tokyo', (record) =>
		Ok({ to: record?.to ?? 'Tokyo', nights: (record?.nights ?? 0) + 1 }),
	);
	expect(made.data?.nights).toBe(1);
	const again = await watches.edit('tokyo', (record) =>
		Ok({ nights: (record?.nights ?? 0) + 1 }),
	);
	expect(again.data?.nights).toBe(2);
	const refused = await watches.edit('tokyo', () =>
		ActionError.Refused({ message: 'not today' }),
	);
	expect(refused).toEqual(Err({ name: 'Refused', message: 'not today' }));
	expect((await watches.get('tokyo')).data?.nights).toBe(2);
});

test('an id that cannot be a file name is refused before any file is touched', async () => {
	const home = await tempHome();
	const { watches } = defineData(home, data);
	for (const id of ['../escape', 'a/b', ''])
		expect((await watches.create(id, { to: 'x' })).error?.name).toBe('Misfit');
	expect(await readdir(home)).toEqual([]);
});

test('list reads each .md file in the key folder, sorted, and nothing else', async () => {
	const home = await tempHome();
	const { watches } = defineData(home, data);
	await watches.create('b', { to: 'B' });
	await watches.create('a', { to: 'A' });
	await writeFile(join(home, 'data/watches/notes.txt'), 'not a record');
	expect((await watches.list()).map((read) => read.data?.id)).toEqual([
		'a',
		'b',
	]);
});

test('a key folder that is a link is never read or written through', async () => {
	const home = await tempHome();
	const away = await tempHome();
	await mkdir(join(home, 'data'));
	await symlink(away, join(home, 'data/watches'));
	const { watches } = defineData(home, data);
	await expect(watches.create('tokyo', { to: 'Tokyo' })).rejects.toThrow(
		'data/watches is a link',
	);
	await expect(watches.delete('tokyo')).rejects.toThrow(
		'data/watches is a link',
	);
	await writeFile(join(away, 'osaka.md'), '---\nto: "Osaka"\n---\n');
	expect(await watches.get('osaka')).toEqual(Ok(undefined));
	expect(await watches.list()).toEqual([]);
	expect(await readdir(away)).toEqual(['osaka.md']);
});

test('a write leaves no temporary file under data/', async () => {
	const home = await tempHome();
	const { watches } = defineData(home, data);
	await watches.create('tokyo', { to: 'Tokyo' });
	await watches.patch('tokyo', { to: 'Kyoto' });
	expect(await readdir(join(home, 'data/watches'))).toEqual(['tokyo.md']);
	expect(await readFile(join(home, 'local/.gitignore'), 'utf8')).toBe('*\n');
});

test('definitions are refused for what their types cannot say', () => {
	expect(() => defineData('relative', {})).toThrow('absolute path');
	expect(() =>
		defineData('/home', { Notes: { description: 'note', fields: {} } }),
	).toThrow('must be lowercase');
	expect(() =>
		defineData('/home', {
			notes: { description: 'note', fields: { id: field.text() } },
		}),
	).toThrow('reserves the field "id"');
	expect(() =>
		defineData('/home', {
			checks: { description: 'check', fields: { watch: field.ref('watches') } },
		}),
	).toThrow('which must be a key in this defineData');
});
