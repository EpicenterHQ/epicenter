/**
 * Schema exchange through fresh CLI processes preserves folder metadata and
 * requires explicit conflict replacement. Export remains JSON and read-only;
 * stdin imports and legacy generate use the same durable declaration format.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
const command = process.env.EPICENTER_BIN
	? [resolve(process.env.EPICENTER_BIN)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];
const tasks = {
	type: 'object',
	properties: { title: { type: 'string' } },
	required: ['title'],
};

afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

async function setup() {
	const parent = await mkdtemp(join(tmpdir(), 'epicenter-schema-'));
	roots.push(parent);
	const directory = join(parent, 'work');
	await mkdir(directory);
	const run = (args: string[], input?: string) => {
		const result = Bun.spawnSync([...command, ...args], {
			cwd: directory,
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: '/dev/null',
				GIT_CONFIG_NOSYSTEM: '1',
			},
			stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
			stdout: 'pipe',
			stderr: 'pipe',
		});
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	};
	return { parent, directory, run, path: join(directory, 'epicenter.json') };
}

test('stdin import creates only a declaration and export returns its tables without touching files', async () => {
	const fixture = await setup();
	const imported = fixture.run(
		['schema', 'import', fixture.directory, '-', '--json'],
		JSON.stringify({ tables: { tasks } }),
	);
	expect(imported.exitCode).toBe(0);
	expect(JSON.parse(imported.stdout)).toEqual({
		written: true,
		path: 'epicenter.json',
	});
	expect(await readdir(fixture.directory)).toEqual(['epicenter.json']);
	const before = await readFile(fixture.path, 'utf8');
	const exported = fixture.run(['schema', 'export', fixture.directory]);
	expect(exported.exitCode).toBe(0);
	expect(JSON.parse(exported.stdout)).toEqual({ tables: { tasks } });
	expect(await readFile(fixture.path, 'utf8')).toBe(before);
	const again = fixture.run(
		['schema', 'import', fixture.directory, '-', '--json'],
		exported.stdout,
	);
	expect(JSON.parse(again.stdout).written).toBe(false);
});

test('file import preserves views and metadata and replaces only a selected conflicting table', async () => {
	const fixture = await setup();
	const old = { type: 'object', properties: { text: { type: 'string' } } };
	const document = {
		$schema: 'editor',
		title: 'Work',
		views: { keep: { type: 'future', value: 3 } },
		tables: { tasks: old, other: old },
	};
	const source = join(fixture.parent, 'schema.json');
	await writeFile(fixture.path, JSON.stringify(document));
	await writeFile(source, JSON.stringify({ tables: { tasks } }));
	const denied = fixture.run(['schema', 'import', fixture.directory, source]);
	expect(denied.exitCode).toBe(2);
	expect(denied.stderr).toContain('--replace');
	expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toEqual(document);
	const replaced = fixture.run([
		'schema',
		'import',
		fixture.directory,
		source,
		'--replace',
	]);
	expect(replaced.exitCode).toBe(0);
	expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toEqual({
		...document,
		tables: { tasks, other: old },
	});
	expect(
		JSON.parse(fixture.run(['schema', 'export', fixture.directory]).stdout),
	).toEqual({ tables: { tasks, other: old } });
});

test('duplicate keys and invalid schema input leave the current source byte-for-byte unchanged', async () => {
	const fixture = await setup();
	for (const source of [
		'{"tables":{},"views":{"a":{"title":"A","title":"B"}}}',
		'{broken',
	]) {
		await writeFile(fixture.path, source);
		const refused = fixture.run(
			['schema', 'import', fixture.directory, '-'],
			JSON.stringify({ tables: { tasks } }),
		);
		expect(refused.exitCode).toBe(2);
		expect(await readFile(fixture.path, 'utf8')).toBe(source);
	}
	await writeFile(fixture.path, '{"tables":{}}');
	const invalid = fixture.run(
		['schema', 'import', fixture.directory, '-'],
		'{"tables":{"tasks":{"type":"made-up"}}}',
	);
	expect(invalid.exitCode).toBe(2);
	expect(await readFile(fixture.path, 'utf8')).toBe('{"tables":{}}');
});

test('legacy generate retains views and schema hints while updating its owned sections', async () => {
	const fixture = await setup();
	const kept = {
		$schema: 'editor',
		views: { draft: { type: 'future', value: [1, 2] } },
	};
	await writeFile(
		fixture.path,
		JSON.stringify({ ...kept, title: 'Old', tables: {} }),
	);
	await writeFile(
		join(fixture.directory, 'epicenter.ts'),
		"import { defineFolder, defineTable, field } from '@epicenter/folder'; export default defineFolder({ title: 'New', tables: { tasks: defineTable({ fields: { title: field.string() } }) } });",
	);
	const result = fixture.run(['generate', fixture.directory]);
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(await readFile(fixture.path, 'utf8'))).toEqual({
		...kept,
		title: 'New',
		tables: {
			tasks: {
				...tasks,
				properties: {
					title: { type: 'string', 'x-field': { kind: 'string' } },
				},
			},
		},
	});
});

test('generate refuses a legacy declaration that would write a malformed table schema', async () => {
	const fixture = await setup();
	const before = '{"tables":{},"views":{"retained":{"type":"future"}}}';
	await writeFile(fixture.path, before);
	await writeFile(
		join(fixture.directory, 'epicenter.ts'),
		"import { defineFolder, defineTable } from '@epicenter/folder'; export default defineFolder({ tables: { tasks: defineTable({ fields: { title: { type: 'strng' } } }) } });",
	);
	const result = fixture.run(['generate', fixture.directory]);
	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain('type');
	expect(await readFile(fixture.path, 'utf8')).toBe(before);
});

test('schema import refuses a declaration whose high-precision bytes it cannot keep', async () => {
	const fixture = await setup();
	const before = '{"tables":{},"views":{"future":{"value":9007199254740993}}}';
	await writeFile(fixture.path, before);
	const imported = fixture.run(
		['schema', 'import', fixture.directory, '-'],
		JSON.stringify({ tables: { tasks } }),
	);
	expect(imported.exitCode).toBe(2);
	expect(imported.stderr).toContain('cannot be preserved exactly');
	expect(await readFile(fixture.path, 'utf8')).toBe(before);
});
