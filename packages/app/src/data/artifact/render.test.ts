import { describe, expect, test } from 'bun:test';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { compileData } from '@epicenter/app/definition';
import * as Y from '@y/y';
import * as delta from 'lib0/delta';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openMemory } from '../store/memory.js';
import { type RenderedRow, renderArtifact, renderRow } from './render.js';

const store = defineStore({
	id: 'so.epicenter.honeycrisp',
	kv: { theme: field.string() },
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
			},
			body: plainText(),
		}),
	},
});

/** Write text into one row's live `body` node. */
function type(
	data: {
		tables: {
			notes: { body(rowId: string): Y.Node | undefined };
		};
	},
	rowId: string,
	text: string,
): void {
	const body = data.tables.notes.body(rowId);
	if (body === undefined) throw new Error('the row has no body');
	body.insert(0, [text]);
}

/** Collect the stream into a map, which is what an assertion wants. */
async function collect(
	stream: AsyncIterable<{ data: RenderedRow | null; error: unknown }>,
): Promise<ReadonlyMap<string, string>> {
	const files = new Map<string, string>();
	for await (const rendered of stream) {
		if (rendered.error !== null) throw rendered.error;
		const { path, contents } = rendered.data as RenderedRow;
		if (contents !== undefined) files.set(path, contents);
	}
	return files;
}

/** The parsed definition `renderRow` reads codecs from. */
function parsed(definition: Parameters<typeof compileData>[0]) {
	return expectOk(compileData(definition));
}

describe('renderRow is the unit (ADR-0271)', () => {
	test('one row becomes one file: fields on top, body text underneath', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		type(data, made.id, 'buy milk');

		const rendered = expectOk(
			await renderRow(data, parsed(store), 'notes', made.id),
		);
		expect(rendered.path).toBe(`notes/${made.id}.md`);
		expect(rendered.contents).toBe(
			['---', 'title: "Groceries"', '---', '', 'buy milk', ''].join('\n'),
		);
	});

	test('a row that is gone renders no contents, which is the unlink signal', async () => {
		// What a subscriber needs for a deletion: the ids a commit touched include
		// the ones it removed, so the same call answers write-this and unlink-that.
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		data.tables.notes.delete(made.id);

		const rendered = expectOk(
			await renderRow(data, parsed(store), 'notes', made.id),
		);
		expect(rendered.path).toBe(`notes/${made.id}.md`);
		expect(rendered.contents).toBeUndefined();
	});

	test('a table with an empty body node renders frontmatter alone', async () => {
		const valuesOnly = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				folders: defineTable({
					fields: {
						name: field.string(),
					},
					body: plainText(),
				}),
			},
		});
		await using data = await openMemory(valuesOnly);
		const made = data.tables.folders.create({ name: 'Inbox' });

		const rendered = expectOk(
			await renderRow(data, parsed(valuesOnly), 'folders', made.id),
		);
		expect(rendered.contents).toBe(
			['---', 'name: "Inbox"', '---', ''].join('\n'),
		);
	});

	test('root attributes refuse a sequence-only body export', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		data.tables.notes.body(made.id)!.setAttr('legacy', 'kept');
		const refused = expectErr(await renderRow(data, parsed(store), 'notes', made.id));
		expect(refused.name).toBe('BodyUnwritable');
	});

	test('a codec that throws is a refusal, not an escaping exception', async () => {
		// A codec that throws is reported as a file failure.
		const breaking = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					fields: {
						title: field.string(),
					},
					body: {
						encode: () => {
							throw new Error('the codec exploded');
						},
						decode: () => delta.create().done(),
					},
				}),
			},
		});
		await using data = await openMemory(breaking);
		const made = data.tables.notes.create({ title: 'Groceries' });

		const refused = expectErr(
			await renderRow(data, parsed(breaking), 'notes', made.id),
		);
		expect(refused.name).toBe('BodyUnwritable');
	});

	test('a field the declaration dropped is in the file, because the read is faithful', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		data.tables.notes.update(made.id, { legacy: 'kept' } as never);

		const rendered = expectOk(
			await renderRow(data, parsed(store), 'notes', made.id),
		);
		expect(rendered.contents).toContain('legacy: "kept"');
		expect(data.tables.notes.rows[0]).not.toHaveProperty('legacy');
	});
});

describe('renderArtifact is renderRow in a loop (ADR-0267/0268)', () => {
	test('exports kv.json and one markdown file per row, fields above the body', async () => {
		await using data = await openMemory(store);
		data.kv.update({ theme: 'dark' });
		const made = data.tables.notes.create({ title: 'Groceries' });
		type(data, made.id, 'buy milk');

		const files = await collect(renderArtifact(data, store));

		expect(JSON.parse(files.get('kv.json') ?? 'null')).toEqual({
			theme: 'dark',
		});

		// The row is one file: its id is the path, its values the frontmatter
		// (strings always quoted, so every value re-reads as itself), and its
		// body node to the body (ADR-0268, ADR-0296).
		expect(files.get(`notes/${made.id}.md`)).toBe(
			['---', 'title: "Groceries"', '---', '', 'buy milk', ''].join('\n'),
		);
		expect([...files.keys()].sort()).toEqual([
			'kv.json',
			`notes/${made.id}.md`,
		]);
	});

	test('a row the declaration no longer names is still in the artifact', async () => {
		await using data = await openMemory(store);
		const made = data.tables.notes.create({ title: 'Groceries' });
		// A value written under an older declaration: the lens cannot see it,
		// and the artifact must carry it anyway.
		data.tables.notes.update(made.id, { legacy: 'kept' } as never);

		const files = await collect(renderArtifact(data, store));
		expect(files.get(`notes/${made.id}.md`) ?? '').toContain('legacy: "kept"');
		expect(data.tables.notes.rows[0]).not.toHaveProperty('legacy');
	});

	test('one row that cannot render does not cost the others their files', async () => {
		// The contract flipped when the consumer did. Export fed a destructive
		// restore, so it abandoned the artifact over one bad row; the mirror
		// writes files, and refusing to write 999 of them over the 1000th is
		// worse than a folder missing one file the next commit re-renders.
		const poisoned = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				notes: defineTable({
					fields: {
						title: field.string(),
					},
					body: {
						// Poisoned for ONE row, so the loop has both to carry.
						encode: (node) => {
							const text = node.toString();
							if (text.includes('poison')) {
								throw new Error('the codec exploded');
							}
							return text;
						},
						decode: () => delta.create().done(),
					},
				}),
			},
		});
		await using data = await openMemory(poisoned);
		const bad = data.tables.notes.create({ title: 'broken' });
		const good = data.tables.notes.create({ title: 'fine' });
		type(data, bad.id, 'poison');

		const seen: { ok: string[]; failed: number } = { ok: [], failed: 0 };
		for await (const rendered of renderArtifact(data, poisoned)) {
			if (rendered.error !== null) seen.failed += 1;
			else seen.ok.push(rendered.data.path);
		}
		expect(seen.failed).toBe(1);
		expect(seen.ok).toContain(`notes/${good.id}.md`);
		expect(seen.ok).toContain('kv.json');
		expect(seen.ok).not.toContain(`notes/${bad.id}.md`);
	});

	test('a table with an empty body node exports frontmatter-only files', async () => {
		const valuesOnly = defineStore({
			id: 'so.epicenter.honeycrisp',
			kv: {},
			tables: {
				folders: defineTable({
					fields: {
						name: field.string(),
					},
					body: plainText(),
				}),
			},
		});
		await using data = await openMemory(valuesOnly);
		const made = data.tables.folders.create({ name: 'Inbox' });

		const files = await collect(renderArtifact(data, valuesOnly));
		expect(files.get(`folders/${made.id}.md`)).toBe(
			['---', 'name: "Inbox"', '---', ''].join('\n'),
		);
	});
});
