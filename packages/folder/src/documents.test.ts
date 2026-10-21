/**
 * Generic document interpretation and SQL tests.
 * Root and nested Markdown retain source and diagnostics. Missing frontmatter
 * has empty fields, while malformed headers remain repairable. SQL uses the
 * same reading, admits only reads, and never invents observed wide columns.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { documentChange, readDocument } from './documents.js';
import { queryDocuments } from './query-documents.js';

const bytes = (text: string) => new TextEncoder().encode(text);

test('root and nested Markdown without frontmatter keep their full body and gain fields explicitly', () => {
	const doc = readDocument('notes/deep/a.md', bytes('hello\r\n'));
	expect(doc).toMatchObject({
		path: 'notes/deep/a.md',
		directory: 'notes/deep',
		stem: 'a',
		fields: {},
		issues: null,
		body: 'hello\r\n',
	});
	expect(expectOk(documentChange(doc, { body: 'changed\r\n' })).text).toBe(
		'changed\r\n',
	);
	const changed = expectOk(documentChange(doc, { fields: { title: 'Title' } }));
	expect(readDocument('a.md', bytes(changed.text))).toMatchObject({
		fields: { title: 'Title' },
		body: 'hello\r\n',
	});
});

test('malformed frontmatter and schema problems retain exact source and reject unsafe field editing', () => {
	const broken = readDocument('a.md', bytes('---\ntitle: [\n---\nbody\n'));
	expect(broken.text).toBe('---\ntitle: [\n---\nbody\n');
	expect(broken.issues?.[0]?.kind).toBe('frontmatter');
	expect(broken.fields).toBeUndefined();
	expect(broken.body).toBe('body\n');
	expectErr(documentChange(broken, { fields: { title: 'new' } }));
	const schema = Type.Object({ title: Type.String() });
	expect(
		readDocument('empty.md', bytes('body'), schema).issues?.[0]?.kind,
	).toBe('schema');
});

test('raw SQL keeps arbitrary field names and malformed documents while naming non-text exclusions', () => {
	const reading = {
		documents: [
			readDocument(
				'a.md',
				bytes('---\nTitle: A\ntitle: b\nbody: field\n---\ncontent\n'),
			),
			readDocument('broken.md', bytes('---\nbroken: [\n---\nbody')),
			readDocument('binary.md', new Uint8Array([255])),
		],
		tables: {},
		unreadable: [{ path: 'link.md', message: 'not a regular file' }],
	};
	const result = expectOk(
		queryDocuments(
			reading,
			`SELECT path, json_extract(fields, '$.Title') AS title, body, json_array_length(issues) AS issues FROM documents ORDER BY path`,
		),
	);
	expect(result.rows).toHaveLength(2);
	expect(result.rows[0]).toMatchObject({
		path: 'a.md',
		title: 'A',
		body: 'content\n',
		issues: 0,
	});
	expect(result.rows[1]?.issues).toBeGreaterThan(0);
	expect(result.excluded.sort()).toEqual(['binary.md', 'link.md']);
	for (const sql of [
		'DELETE FROM documents',
		"ATTACH 'x' AS x",
		'SELECT 1; DELETE FROM documents',
		'WITH a AS (SELECT 1) DELETE FROM documents',
	])
		expectErr(queryDocuments(reading, sql));
	expect(
		expectOk(queryDocuments(reading, 'SELECT count(*) AS n FROM documents'))
			.rows,
	).toEqual([{ n: 2 }]);
});

test('directory SQL and the open editor share declared diagnostics without requiring valid saved views', async () => {
	const { mkdtemp, writeFile, mkdir, rm, symlink } = await import(
		'node:fs/promises'
	);
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { openBunFolder } = await import('./native/bun.js');
	const { readDirectoryDocuments } = await import('./directory-documents.js');
	const { readDocuments } = await import('./documents.js');
	const directory = await mkdtemp(join(tmpdir(), 'epicenter-documents-'));
	await mkdir(join(directory, 'notes'));
	await mkdir(join(directory, 'notes/attachments'));
	await writeFile(
		join(directory, 'notes/attachments/README.md'),
		'an attachment',
	);
	await symlink(join(directory, 'notes/a.md'), join(directory, 'linked.md'));
	await writeFile(
		join(directory, 'notes/a.md'),
		'---\ncount: wrong\n---\nbody\n',
	);
	await writeFile(
		join(directory, 'epicenter.json'),
		JSON.stringify({
			tables: {
				notes: { type: 'object', properties: { count: { type: 'number' } } },
			},
			views: 'broken unrelated view',
		}),
	);
	const folder = expectOk(await openBunFolder({ directory, tables: {} }));
	try {
		const desktop = expectOk(await readDirectoryDocuments(directory));
		const editor = expectOk(await readDocuments(folder.files));
		expect(desktop.documents).toEqual(editor.documents);
		expect(
			desktop.documents.find((doc) => doc.path === 'notes/a.md')?.issues?.[0]
				?.kind,
		).toBe('schema');
		expect(
			desktop.documents.find(
				(doc) => doc.path === 'notes/attachments/README.md',
			)?.issues,
		).toBeNull();
		expect(desktop.unreadable).toEqual(editor.unreadable);
		expect(desktop.unreadable[0]?.path).toBe('linked.md');
		const query = expectOk(
			queryDocuments(desktop, 'SELECT issues FROM documents'),
		);
		expect(JSON.parse(String(query.rows[0]?.issues))[0]?.kind).toBe('schema');
		await writeFile(join(directory, 'epicenter.json'), '{');
		const repairable = expectOk(await readDirectoryDocuments(directory));
		expect(repairable.declarationProblem).toBeDefined();
		expect(repairable.documents).toHaveLength(2);
		expect(
			expectOk(queryDocuments(repairable, 'SELECT path FROM documents'))
				.warnings,
		).toHaveLength(1);
	} finally {
		await folder.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test('desktop SQL caps row count and encoded output size', () => {
	const reading = { documents: [], unreadable: [], tables: {} };
	const count = expectOk(
		queryDocuments(
			reading,
			'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) SELECT x FROM n',
		),
	);
	expect(count.rows).toHaveLength(1000);
	expect(count.truncated).toBe(true);
	const large = expectOk(
		queryDocuments(reading, "SELECT printf('%.*c', 4194305, 'x') AS large"),
	);
	expect(large.rows).toHaveLength(0);
	expect(large.truncated).toBe(true);
});

test('a throwing validator keeps the document source and raw fields available', () => {
	const schema = Type.Object({
		title: Type.Refine(Type.String(), () => {
			throw new Error('validator failed');
		}),
	});
	const doc = readDocument(
		'notes/a.md',
		bytes('---\ntitle: value\n---\nbody\n'),
		schema,
	);
	expect(doc.fields).toEqual({ title: 'value' });
	expect(doc.body).toBe('body\n');
	expect(doc.issues?.[0]?.message).toContain('validator failed');
});
