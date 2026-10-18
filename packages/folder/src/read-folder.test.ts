/**
 * Read Folder Tests
 *
 * `readFolder` reads a data folder on disk without opening it, through the
 * same tables and native file boundary an opened folder uses.
 *
 * Key behaviors:
 * - A table is a top-level directory holding a `.epicenter.json`; a
 *   directory without one is not a table, and a root `epicenter.json` is
 *   ignored
 * - Every discovered table is exactly what an opened folder's `list()` returns
 * - A directory with no table is `NotDataFolder`; a schema file that is not
 *   UTF-8 JSON, is not the schema grammar (an unknown key, a `required`
 *   naming no property, a visible `~optional`), or declares a field a folder
 *   cannot keep (an unknown format, a `$ref` naming nothing, an `$id` two
 *   fields define) is a problem naming its path while the other tables read;
 *   a directory that cannot name a table is passed over; a missing root is
 *   `NotFound`, a file root `NotADirectory`
 * - A hand-written declaration with optional fields reads sparse rows as
 *   valid, and an absent required field as missing
 * - A symbolically linked directory is never followed, so it is not a
 *   table, and the other tables still read
 * - It writes nothing: no Git repository, marker, lock, or declaration
 * - A data folder nested inside another repository reads like any other
 */
import { afterAll, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	defineFolder,
	defineTable,
	field,
	formatDefinition,
	openFolder,
	readFolder,
	schemaPath,
} from './bun.js';
import { readDefinition } from './declaration.js';
import { FileError } from './errors.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({ fields: { title: field.string() } }),
		notes: defineTable({ fields: { body: field.string() } }),
	},
});

/** A table as its `.epicenter.json` holds it: every field required unless listed otherwise. */
const objectSchema = (
	properties: Record<string, object>,
	required = Object.keys(properties),
) => ({ type: 'object', properties, required });

/** Write each table's schema file: an object as JSON, a string as it is. */
async function writeTables(
	root: string,
	tables: Record<string, object | string>,
) {
	for (const [name, schema] of Object.entries(tables)) {
		await mkdir(join(root, name), { recursive: true });
		await writeFile(
			join(root, schemaPath(name)),
			typeof schema === 'string' ? schema : JSON.stringify(schema),
		);
	}
}

/** The one schema problem `readFolder` reports for `root`: its path and reason. */
async function problemOf(root: string) {
	const reading = expectOk(await readFolder(root));
	expect(reading.problems).toHaveLength(1);
	return reading.problems[0]!;
}

const roots: string[] = [];
afterAll(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratch() {
	const root = await mkdtemp(join(tmpdir(), 'read-folder-'));
	roots.push(root);
	return root;
}

/** Every path under a directory, with its size, so a read can be shown to write nothing. */
async function tree(root: string): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(root, {
		recursive: true,
		withFileTypes: true,
	})) {
		const path = join(entry.parentPath, entry.name);
		const size = entry.isFile() ? (await stat(path)).size : 0;
		out.push(`${path.slice(root.length)}:${entry.isDirectory() ? 'd' : size}`);
	}
	return out.sort();
}

test('an opened folder reads back exactly as its tables list it', async () => {
	const root = await scratch();
	const folder = expectOk(
		await openFolder({
			app: basename(root),
			root,
			definition,
			git: { author: { name: 'T', email: 't@example.test' } },
		}),
	);
	expectOk(
		await folder.tables.todos.create(
			{ fields: { title: 'Milk' }, body: '' },
			{ stem: 'milk' },
		),
	);
	expectOk(await folder.write('todos/broken.md', null, '---\ntitle: [\n---\n'));
	const listed = expectOk(await folder.tables.todos.list());
	await folder.close();

	const reading = expectOk(await readFolder(root));
	expect(Object.keys(reading.tables).sort()).toEqual(['notes', 'todos']);
	expect(expectOk(reading.tables.todos!)).toEqual(listed);
	expect(expectOk(reading.tables.notes!)).toEqual([]);
	expect(Object.keys(reading.definition.tables).sort()).toEqual([
		'notes',
		'todos',
	]);
});

test('a table is a top-level directory holding .epicenter.json; nothing else is', async () => {
	const root = await scratch();
	expect(expectErr(await readFolder(root)).name).toBe('NotDataFolder');
	// A root epicenter.json declares nothing, and neither does a directory
	// without a schema, a nested schema, or a root .epicenter.json.
	await writeFile(
		join(root, 'epicenter.json'),
		JSON.stringify({
			tables: { todos: objectSchema({ title: { type: 'string' } }) },
		}),
	);
	await writeFile(join(root, '.epicenter.json'), '{}');
	await mkdir(join(root, 'attachments'));
	await writeFile(join(root, 'attachments', 'a.md'), '---\ntitle: A\n---\n');
	await mkdir(join(root, 'deep', 'cards'), { recursive: true });
	await writeFile(
		join(root, 'deep', 'cards', '.epicenter.json'),
		JSON.stringify(objectSchema({ title: { type: 'string' } })),
	);
	await mkdir(join(root, 'todos'));
	await writeFile(join(root, 'todos', 'a.md'), '---\ntitle: A\n---\n');
	expect(expectErr(await readFolder(root)).name).toBe('NotDataFolder');

	await writeTables(root, {
		notes: objectSchema({ body: { type: 'string' } }),
	});
	const reading = expectOk(await readFolder(root));
	expect(Object.keys(reading.tables)).toEqual(['notes']);
	expect(Object.keys(reading.definition.tables)).toEqual(['notes']);
	expect(reading.definition).not.toHaveProperty('title');
});

test('a schema file that cannot be used is a problem naming its path, and the other tables still read', async () => {
	for (const text of [
		'{ not json',
		'null',
		'[]',
		JSON.stringify({ fields: { title: { type: 'string' } } }),
		JSON.stringify(objectSchema({ title: { type: 'string' } }, ['nope'])),
		JSON.stringify(
			objectSchema({ title: { type: 'string', '~optional': true } }, []),
		),
		JSON.stringify({ tables: {} }),
		JSON.stringify({
			...objectSchema({ title: { type: 'string' } }),
			local: ['audio/'],
		}),
	]) {
		const root = await scratch();
		await writeTables(root, {
			notes: objectSchema({ body: { type: 'string' } }),
			todos: text,
		});
		const reading = expectOk(await readFolder(root));
		expect(Object.keys(reading.tables)).toEqual(['notes']);
		expect(reading.problems).toEqual([
			{ path: 'todos/.epicenter.json', reason: expect.any(String) },
		]);
	}
});

test('a directory that cannot name a table is passed over, or named as a problem when it holds a schema', async () => {
	const root = await scratch();
	const schema = objectSchema({ body: { type: 'string' } });
	await writeTables(root, {
		notes: schema,
		'my-drafts': schema,
		order: schema,
		'.hidden': schema,
		HEAD: schema,
	});
	const reading = expectOk(await readFolder(root));
	expect(Object.keys(reading.tables)).toEqual(['notes']);
	expect(reading.problems.map(({ path }) => path).sort()).toEqual([
		'my-drafts/.epicenter.json',
		'order/.epicenter.json',
	]);
	expect(reading.problems[0]!.reason).toContain('cannot name a table');
	// A folder whose only schemas cannot be used is still a data folder.
	await rm(join(root, 'notes'), { recursive: true });
	expect(Object.keys(expectOk(await readFolder(root)).tables)).toEqual([]);
});

test('an unknown key in a schema is a problem, and $schema is allowed', async () => {
	const root = await scratch();
	const todos = objectSchema({ title: { type: 'string' } });
	await writeTables(root, { todos: { ...todos, propertys: {} } });
	expect((await problemOf(root)).reason).toContain("'propertys'");

	await writeTables(root, {
		todos: { ...todos, $schema: 'https://example.test/s.json' },
	});
	expect(Object.keys(expectOk(await readFolder(root)).tables)).toEqual([
		'todos',
	]);
});

test('a field with an unknown format is a problem, naming the field', async () => {
	const root = await scratch();
	await writeTables(root, {
		todos: objectSchema({ due: { type: 'string', format: 'date-tme' } }),
	});
	const { reason } = await problemOf(root);
	expect(reason).toContain('todos.due');
	expect(reason).toContain('date-tme');
});

test('a field whose $ref names nothing, or that would resolve differently in the file, is a problem, naming the reference', async () => {
	const node = {
		$defs: {
			Node: {
				$id: 'Node',
				type: 'object',
				properties: { next: { anyOf: [{ $ref: 'Node' }, { type: 'null' }] } },
			},
		},
		$ref: 'Node',
	};
	for (const [fields, says] of [
		[{ chain: { $ref: 'Node' } }, ['todos.chain', "'Node'"]],
		[
			{ text: { $defs: { t: { type: 'string' } }, $ref: '#/$defs/txt' } },
			['todos.text', "'#/$defs/txt'"],
		],
		[{ a: node, b: node }, ["'todos.a' and 'todos.b'", "$id 'Node'"]],
	] as const) {
		const root = await scratch();
		await writeTables(root, { todos: objectSchema(fields) });
		const { reason } = await problemOf(root);
		for (const said of says) expect(reason).toContain(said);
	}
});

test('a hand-written declaration with optional fields reads sparse rows as valid and an absent required field as missing', async () => {
	const root = await scratch();
	await writeTables(root, {
		pages: objectSchema(
			{
				title: { type: 'string' },
				queuedAt: { type: 'string', format: 'date' },
			},
			['title'],
		),
	});
	await writeFile(join(root, 'pages', 'a.md'), '---\ntitle: A\n---\n');
	await writeFile(
		join(root, 'pages', 'b.md'),
		'---\ntitle: B\nqueuedAt: 2026-10-11\n---\n',
	);
	await writeFile(join(root, 'pages', 'c.md'), '---\nqueuedAt: nope\n---\n');

	const listed = expectOk(expectOk(await readFolder(root)).tables.pages!);
	expect(
		listed.map(({ stem, result }) => [
			stem,
			result.error === null
				? result.data.row.fields
				: result.error.name === 'InvalidRow'
					? result.error.issues.map((issue) => issue.field)
					: result.error.name,
		]),
	).toEqual([
		['a', { title: 'A' }],
		['b', { title: 'B', queuedAt: '2026-10-11' }],
		['c', ['queuedAt', 'title']],
	]);
});

test('a written folder publishes each table as a standard object schema, and reads it back the same', async () => {
	const root = await scratch();
	const sparse = defineFolder({
		tables: {
			pages: defineTable({
				fields: {
					title: field.string(),
					queuedAt: field.optional(field.nullable(field.date())),
				},
			}),
		},
	});
	const folder = expectOk(
		await openFolder({
			app: basename(root),
			root,
			definition: sparse,
			git: { author: { name: 'T', email: 't@example.test' } },
		}),
	);
	// Opening writes nothing; the first write publishes the declaration.
	expectOk(
		await folder.tables.pages.create(
			{ fields: { title: 'First' }, body: '' },
			{ stem: 'first' },
		),
	);
	await folder.close();
	const published = JSON.parse(
		await readFile(join(root, schemaPath('pages')), 'utf8'),
	);
	expect(Object.keys(published)).toEqual(['type', 'properties', 'required']);
	expect(published.type).toBe('object');
	expect(published.required).toEqual(['title']);
	expect(JSON.stringify(published)).not.toContain('~');
	expect(await readFile(join(root, 'epicenter.json')).catch(() => null)).toBe(
		null,
	);
	const reading = expectOk(await readFolder(root));
	expect(formatDefinition(reading.definition)).toEqual(
		formatDefinition(sparse),
	);
});

test('a missing root is NotFound and a file root is NotADirectory', async () => {
	const parent = await scratch();
	expect(expectErr(await readFolder(join(parent, 'missing')))).toMatchObject({
		name: 'NotFound',
		path: join(parent, 'missing'),
	});
	await writeFile(join(parent, 'file'), '');
	expect(expectErr(await readFolder(join(parent, 'file'))).name).toBe(
		'NotADirectory',
	);
});

test('a .epicenter.json that is not a readable file is a problem', async () => {
	const root = await scratch();
	await mkdir(join(root, schemaPath('todos')), { recursive: true });
	expect((await problemOf(root)).path).toBe('todos/.epicenter.json');
});

test('a file named like a row that is not one is named, so nothing leaves a table unsaid', async () => {
	const root = await scratch();
	await writeTables(root, {
		notes: objectSchema({ body: { type: 'string' } }),
	});
	for (const name of ['a.md', '.b.md', '.md', 'Loud.MD', 'plain.txt'])
		await writeFile(join(root, 'notes', name), '---\nbody: x\n---\n');
	await mkdir(join(root, 'notes/a'));
	await writeFile(join(root, 'notes/a/nested.md'), "a row's own file\n");
	const reading = expectOk(await readFolder(root));
	expect(expectOk(reading.tables.notes!).map(({ stem }) => stem)).toEqual([
		'a',
	]);
	expect(reading.notRows).toEqual([
		'notes/.b.md',
		'notes/.md',
		'notes/Loud.MD',
	]);
});

test('a symbolically linked directory is never followed, so it is no table, and the other tables read', async () => {
	const root = await scratch();
	const elsewhere = await scratch();
	await writeTables(elsewhere, {
		todos: objectSchema({ title: { type: 'string' } }),
	});
	await writeFile(
		join(elsewhere, 'todos', 'a.md'),
		'---\ntitle: Outside\n---\n',
	);
	await symlink(join(elsewhere, 'todos'), join(root, 'todos'));
	await writeTables(root, {
		notes: objectSchema({ body: { type: 'string' } }),
	});
	await writeFile(join(root, 'notes', 'n.md'), '---\nbody: Inside\n---\n');

	const reading = expectOk(await readFolder(root));
	expect(Object.keys(reading.tables)).toEqual(['notes']);
	expect(expectOk(reading.tables.notes!)).toHaveLength(1);
});

test('reading writes nothing, inside a folder nested in another repository', async () => {
	const repository = await scratch();
	await mkdir(join(repository, '.git'));
	const root = join(repository, 'data', 'todos-folder');
	await writeTables(root, {
		todos: objectSchema({ title: { type: 'string' } }),
	});
	await writeFile(join(root, 'todos', 'a.md'), '---\ntitle: A\n---\n');
	const before = await tree(repository);

	const reading = expectOk(await readFolder(root));
	expect(expectOk(reading.tables.todos!)).toHaveLength(1);
	expect(await tree(repository)).toEqual(before);
});

test('table directories whose names differ only by case are problems, and the other tables read', async () => {
	// A case-sensitive disk can hold both; SQL and a case-insensitive disk
	// cannot tell them apart.
	const schema = JSON.stringify(objectSchema({ body: { type: 'string' } }));
	const files = new Map([
		['Notes/.epicenter.json', schema],
		['notes/.epicenter.json', schema],
		['todos/.epicenter.json', schema],
	]);
	const encoder = new TextEncoder();
	const storage = {
		children: async () =>
			Ok({ files: [], directories: ['Notes', 'notes', 'todos'] }),
		read: async (path: string) => {
			const text = files.get(path);
			return text === undefined
				? FileError.NotFound({ path })
				: Ok({ bytes: encoder.encode(text), sha256: '' });
		},
	};
	const { definition, problems } = expectOk(await readDefinition(storage));
	expect(Object.keys(definition.tables)).toEqual(['todos']);
	expect(problems.map(({ path }) => path)).toEqual([
		'Notes/.epicenter.json',
		'notes/.epicenter.json',
	]);
	expect(problems[0]!.reason).toContain('differ only by case');
});
