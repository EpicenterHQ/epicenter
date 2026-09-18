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
import { syncEngineOf } from '@epicenter/app/direct';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { pmToFragment } from '@y/prosemirror';
import { expectOk } from 'wellcrafted/testing';
import { honeycrispDefinition } from './data.js';
import { parseNoteBody } from './editor/markdown.js';

/** The notes table's real codec, which is what these tests are about. */
const noteFile = honeycrispDefinition.tables.notes.content;

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
	pmToFragment(parseNoteBody(MARKDOWN), seeded.content as never);

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
	expect(noteFile.encode(row.content)).toBe(MARKDOWN);
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
	expect(restored.tables.notes.get(note.id)?.content).toBeDefined();
	await data[Symbol.asyncDispose]();
});

/**
 * `rewrite`, which is the verb a push calls when a person authorizes a body
 * edit to come home (ADR-0337).
 *
 * What these pin is the reason it is a verb at all: the node the row holds
 * afterwards is the SAME node, so an editor, an undo manager, and a preview
 * bound to it are still bound. A codec that built a fresh node and let the
 * platform swap it in would pass a round-trip assertion and detach every one of
 * them.
 */
test('a rewritten body says what the file says, in the node the row already holds', async () => {
	const { data, note } = await seed();
	const before = data.tables.notes.get(note.id);
	if (before === undefined) throw new Error('the note has no row');
	pmToFragment(parseNoteBody('# Old\n\nold text'), before.content as never);

	expectOk(noteFile.rewrite(before.content, MARKDOWN));

	const after = data.tables.notes.get(note.id);
	if (after === undefined) throw new Error('the note lost its row');
	// The identity claim, which is the whole point. `toBe`, not `toEqual`.
	expect(after.content).toBe(before.content);
	expect(noteFile.encode(after.content)).toBe(MARKDOWN);
	await data[Symbol.asyncDispose]();
});

test('a rewrite to nothing empties the node without replacing it', async () => {
	const { data, note } = await seed();
	const row = data.tables.notes.get(note.id);
	if (row === undefined) throw new Error('the note has no row');
	pmToFragment(parseNoteBody(MARKDOWN), row.content as never);

	expectOk(noteFile.rewrite(row.content, ''));

	expect(data.tables.notes.get(note.id)?.content).toBe(row.content);
	expect(noteFile.encode(row.content)).toBe('');
	await data[Symbol.asyncDispose]();
});
