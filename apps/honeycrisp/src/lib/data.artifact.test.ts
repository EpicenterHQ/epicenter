/**
 * Honeycrisp's own export and import, end to end (ADR-0267/0268).
 *
 * The promise this app makes about a person's data: what comes out is a folder
 * of Markdown files they can read in any vault tool, and what goes back in is
 * the store they left. Proven against the real definition and the real
 * ProseMirror codec, not a stand-in, because the codec is where the body can
 * actually be lost.
 */
import { expect, test } from 'bun:test';
import { readArtifact, renderArtifact } from '@epicenter/app/artifact';
import { syncEngineOf } from '@epicenter/app/data';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { pmnodeToDelta } from '@y/prosemirror';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition } from './data.js';
import { parseNoteBody } from './editor/markdown.js';

/** The notes table's real codec, which is what these tests are about. */
const noteFile = honeycrispDefinition.tables.notes.body;

const AT = InstantString.fromDate(new Date('2026-08-10T00:00:00.000Z'));

/** Collect the render stream into a map, which is what an assertion wants. */
async function collect(
	stream: AsyncIterable<{
		data: { path: string; contents?: string } | null;
		error: unknown;
	}>,
): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	for await (const rendered of stream) {
		if (rendered.error !== null) throw rendered.error;
		const { path, contents } = rendered.data as {
			path: string;
			contents?: string;
		};
		if (contents !== undefined) files.set(path, contents);
	}
	return files;
}

const MARKDOWN = [
	'# Groceries',
	'',
	'- [ ] buy milk',
	'- [x] ~~pay rent~~',
	'',
	'Some **bold** and *italic* text.',
].join('\n');

async function seed() {
	const data = await openMemory(honeycrispDefinition);
	const folder = data.tables.folders.create({ name: 'Inbox', icon: null });
	const note = data.tables.notes.create({
		folderId: folder.id,
		title: 'Groceries',
		pinned: true,
		createdAt: AT,
		updatedAt: AT,
		deletedAt: null,
	});
	return { data, folder, note };
}

test('a store exports to Markdown files and imports back whole', async () => {
	const { data, note } = await seed();
	const seeded = data.tables.notes.get(note.id);
	if (seeded === undefined) throw new Error('the note has no row');
	data.tables.notes
		.body(seeded.id)!
		.applyDelta(pmnodeToDelta(parseNoteBody(MARKDOWN)));

	const files = await collect(renderArtifact(data, honeycrispDefinition));
	// One file per row, and the note's file is text a person can read.
	expect([...files.keys()].sort()).toEqual(
		[
			`folders/${data.tables.folders.rows[0]?.id}.md`,
			'kv.json',
			`notes/${note.id}.md`,
		].sort(),
	);
	const file = files.get(`notes/${note.id}.md`) ?? '';
	expect(file).toContain('title: "Groceries"');
	expect(file).toContain('- [ ] buy milk');

	const state = expectOk(readArtifact(files, honeycrispDefinition));
	await using restored = await openMemory(honeycrispDefinition);
	expect(syncEngineOf(restored).applyRemote(state).error).toBeNull();

	// Through the faithful read: a row carries its live content node now, and two
	// documents' nodes are never equal objects. The claim is about the record.
	expect(restored.stored().tables).toEqual(data.stored().tables);

	// And the text came back as the same Markdown, through the real codec. One
	// row goes in, not a row spliced together with a bag of types.
	const row = restored.tables.notes.get(note.id);
	if (row === undefined) throw new Error('the note lost its row');
	expect(noteFile.encode(restored.tables.notes.body(row.id)!)).toBe(MARKDOWN);
	await data[Symbol.asyncDispose]();
});

test('a note with no body text exports as frontmatter alone and still imports', async () => {
	const { data, note } = await seed();
	const files = await collect(renderArtifact(data, honeycrispDefinition));
	expect(files.get(`notes/${note.id}.md`)).not.toContain('\n\n');

	const state = expectOk(readArtifact(files, honeycrispDefinition));
	await using restored = await openMemory(honeycrispDefinition);
	syncEngineOf(restored).applyRemote(state);
	expect(restored.tables.notes.get(note.id)?.title).toBe('Groceries');
	// The node is minted with the row, so an empty note still has one.
	expect(restored.tables.notes.body(note.id)).toBeDefined();
	await data[Symbol.asyncDispose]();
});
