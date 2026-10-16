/**
 * Read Folder Tests
 *
 * `readFolder` reads a data folder on disk without opening it, through the
 * same tables and native file boundary an opened folder uses.
 *
 * Key behaviors:
 * - Every declared table is exactly what an opened folder's `list()` returns
 * - A `kv` section an earlier build wrote is admitted and not read
 * - A directory without `epicenter.json` is `NotDataFolder`; a declaration
 *   that is not UTF-8 JSON, is not the declaration grammar (an unknown key, a
 *   `required` naming no property, a visible `~optional`), or declares a field
 *   a folder cannot keep (an unknown format, a `$ref` naming nothing, an `$id`
 *   two fields define) is `InvalidDeclaration`; a missing root is `NotFound`,
 *   a file root `NotADirectory`
 * - A hand-written declaration with optional fields reads sparse rows as
 *   valid, and an absent required field as missing
 * - A symbolically linked table directory is that table's refusal, never
 *   followed, and the other tables still read
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
import { join } from 'node:path';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	DECLARATION_PATH,
	defineFolder,
	defineTable,
	field,
	formatDeclaration,
	openFolder,
	readFolder,
} from './bun.js';

const definition = defineFolder({
	tables: {
		todos: defineTable({ fields: { title: field.string() } }),
		notes: defineTable({ fields: { body: field.string() } }),
	},
});

/** A table as `epicenter.json` holds it: every field required unless listed otherwise. */
const objectSchema = (
	properties: Record<string, object>,
	required = Object.keys(properties),
) => ({ type: 'object', properties, required });

/** `epicenter.json` text with these tables. */
const declaration = (
	tables: Record<string, object>,
	extra: Record<string, unknown> = {},
) => JSON.stringify({ tables, ...extra });

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
	expectOk(
		await folder.files.create('todos/broken.md', '---\ntitle: [\n---\n'),
	);
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

test('a directory without epicenter.json is NotDataFolder', async () => {
	const root = await scratch();
	expect(expectErr(await readFolder(root)).name).toBe('NotDataFolder');
});

test('a declaration that cannot be used is InvalidDeclaration', async () => {
	for (const text of [
		'{ not json',
		'null',
		'[]',
		declaration({ t: { fields: { title: { type: 'string' } } } }),
		declaration({ t: objectSchema({ title: { type: 'string' } }, ['nope']) }),
		declaration({
			t: objectSchema({ title: { type: 'string', '~optional': true } }, []),
		}),
		JSON.stringify({ title: 'No tables' }),
		'{"tables": {"__proto__": {"type": "object", "properties": {}}}}',
	]) {
		const root = await scratch();
		await writeFile(join(root, DECLARATION_PATH), text);
		expect(expectErr(await readFolder(root))).toMatchObject({
			name: 'InvalidDeclaration',
		});
	}
});

test("an earlier build's kv section is admitted and not read", async () => {
	const root = await scratch();
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({
			kv: { type: 'object', properties: { theme: { type: 'string' } } },
			tables: { todos: objectSchema({ title: { type: 'string' } }) },
		}),
	);
	const reading = expectOk(await readFolder(root));
	expect(Object.keys(reading.definition)).toEqual(['tables']);
	expect(Object.keys(reading.definition.tables)).toEqual(['todos']);
});

test('an unknown top-level key is InvalidDeclaration, and $schema is allowed', async () => {
	const root = await scratch();
	const tables = { todos: objectSchema({ title: { type: 'string' } }) };
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({ tabels: tables }),
	);
	const refused = expectErr(await readFolder(root));
	expect(refused).toMatchObject({ name: 'InvalidDeclaration' });
	expect(refused.message).toContain("'tabels'");

	await writeFile(
		join(root, DECLARATION_PATH),
		declaration(tables, { $schema: 'https://example.test/s.json' }),
	);
	expect(Object.keys(expectOk(await readFolder(root)).tables)).toEqual([
		'todos',
	]);
});

test('a field with an unknown format is InvalidDeclaration, naming the field', async () => {
	const root = await scratch();
	await writeFile(
		join(root, DECLARATION_PATH),
		declaration({
			todos: objectSchema({ due: { type: 'string', format: 'date-tme' } }),
		}),
	);
	const refused = expectErr(await readFolder(root));
	expect(refused).toMatchObject({ name: 'InvalidDeclaration' });
	expect(refused.message).toContain('todos.due');
	expect(refused.message).toContain('date-tme');
});

test('a field whose $ref names nothing, or that would resolve differently in the file, is InvalidDeclaration, naming the reference', async () => {
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
		await writeFile(
			join(root, DECLARATION_PATH),
			declaration({ todos: objectSchema(fields) }),
		);
		const refused = expectErr(await readFolder(root));
		expect(refused).toMatchObject({ name: 'InvalidDeclaration' });
		for (const said of says) expect(refused.message).toContain(said);
	}
});

test('a hand-written declaration with optional fields reads sparse rows as valid and an absent required field as missing', async () => {
	const root = await scratch();
	await writeFile(
		join(root, DECLARATION_PATH),
		declaration({
			pages: objectSchema(
				{
					title: { type: 'string' },
					queuedAt: { type: 'string', format: 'date' },
				},
				['title'],
			),
		}),
	);
	await mkdir(join(root, 'pages'));
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
		await readFile(join(root, DECLARATION_PATH), 'utf8'),
	);
	expect(Object.keys(published)).toEqual(['tables']);
	expect(published.tables.pages.type).toBe('object');
	expect(published.tables.pages.required).toEqual(['title']);
	expect(JSON.stringify(published)).not.toContain('~');
	const reading = expectOk(await readFolder(root));
	expect(formatDeclaration(reading.definition)).toBe(formatDeclaration(sparse));
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

test('an epicenter.json that is not a readable file is InvalidDeclaration', async () => {
	const root = await scratch();
	await mkdir(join(root, DECLARATION_PATH));
	expect(expectErr(await readFolder(root))).toMatchObject({
		name: 'InvalidDeclaration',
		root,
	});
});

test('a symbolically linked table directory is refused, not followed, and the other tables read', async () => {
	const root = await scratch();
	const elsewhere = await scratch();
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({
			tables: {
				todos: objectSchema({ title: { type: 'string' } }),
				notes: objectSchema({ body: { type: 'string' } }),
			},
		}),
	);
	await mkdir(join(elsewhere, 'todos'));
	await writeFile(
		join(elsewhere, 'todos', 'a.md'),
		'---\ntitle: Outside\n---\n',
	);
	await symlink(join(elsewhere, 'todos'), join(root, 'todos'));
	await mkdir(join(root, 'notes'));
	await writeFile(join(root, 'notes', 'n.md'), '---\nbody: Inside\n---\n');

	const reading = expectOk(await readFolder(root));
	expect(expectErr(reading.tables.todos!).name).toBe('InvalidPath');
	expect(expectOk(reading.tables.notes!)).toHaveLength(1);
});

test('reading writes nothing, inside a folder nested in another repository', async () => {
	const repository = await scratch();
	await mkdir(join(repository, '.git'));
	const root = join(repository, 'data', 'todos-folder');
	await mkdir(join(root, 'todos'), { recursive: true });
	await writeFile(
		join(root, DECLARATION_PATH),
		JSON.stringify({
			tables: { todos: objectSchema({ title: { type: 'string' } }) },
		}),
	);
	await writeFile(join(root, 'todos', 'a.md'), '---\ntitle: A\n---\n');
	const before = await tree(repository);

	const reading = expectOk(await readFolder(root));
	expect(expectOk(reading.tables.todos!)).toHaveLength(1);
	expect(await tree(repository)).toEqual(before);
});
