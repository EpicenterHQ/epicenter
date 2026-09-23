import {
	type BodyCodec,
	defineStore,
	defineTable,
	field,
	plainText,
	type RowOf,
} from '@epicenter/app';
import type { LocalStore } from '@epicenter/app/open';
import { APPS } from '@epicenter/constants/apps';
/**
 * Honeycrisp's inert application declaration.
 *
 * The root schema is inspectable without opening storage. Only `openLocal()`
 * acquires the live App and its resources.
 *
 * The `folders` and `notes` property names are the durable table names. They
 * are what the row addresses carry and what the export names its folders
 * (ADR-0268).
 */

import { pmnodeToDelta, ynodeToPmnode } from '@y/prosemirror';
import { parseNoteBody, serializeNoteBody } from './editor/markdown.js';
import { noteSchema } from './editor/schema.js';

/** Runtime-minted structural note row id. */
export type NoteId = string;

/** Runtime-minted structural folder row id. */
export type FolderId = string;

/**
 * A note's content node as Markdown, and back (ADR-0296).
 *
 * The whole of what this app declares about its files. The platform writes the
 * values as frontmatter under their own field names and joins this below the
 * fence, and reverses both; only Honeycrisp knows that a note's node is a
 * ProseMirror document rather than a line of text.
 *
 * `decode` cannot fail on well-formed input, because any Markdown parses. What
 * it must not do is judge the frontmatter: a value this release cannot read is
 * reported as nonconforming on the first read rather than refused at the door
 * (ADR-0125), which is what keeps an artifact readable by the release that has
 * to fix it, and what keeps one hand-edited file from costing somebody the
 * import of their whole folder.
 */
const noteMarkdown: BodyCodec = {
	encode: (node) => serializeNoteBody(ynodeToPmnode(node, noteSchema)),
	decode: (text) => pmnodeToDelta(parseNoteBody(text)),
};

export const honeycrispDefinition = defineStore({
	id: APPS.HONEYCRISP.id,
	title: 'Honeycrisp',
	kv: {},
	tables: {
		folders: defineTable({
			fields: {
				name: field.string(),
				// Nullable rather than optional. A data definition has no optional
				// fields on purpose: a field has to be one type through the CRDT
				// attribute, the exported frontmatter value and the row alike, and
				// "absent" is not one. Application recovery supplies a value at read
				// time and never writes it as part of the definition (ADR-0255).
				icon: field.nullable(field.string()),
			},
			// Folder bodies serialize as plain text. Nothing writes there today;
			// the store creates the body independently of this codec.
			body: plainText(),
		}),
		notes: defineTable({
			fields: {
				folderId: field.nullable(field.string()),
				title: field.string(),
				pinned: field.boolean(),
				// Validation-only rather than `string.date.parse`: a field has to be
				// one type through the CRDT attribute, the exported frontmatter value
				// and the row alike, and a parsing form would hand back a `Date` that
				// could not round-trip.
				// Ordinary fields nobody stamps but Honeycrisp (ADR-0297). The store
				// stopped holding an opinion about time, so `openContent` is what moves
				// `updatedAt`, and `create` is what sets `createdAt`.
				createdAt: field.instant(),
				updatedAt: field.instant(),
				deletedAt: field.nullable(field.instant()),
			},
			body: noteMarkdown,
		}),
	},
});

/**
 * The store handle consumed by the notes UI. Local and Personal share this
 * schema and capability shape; their owning App closes them together.
 */
export type HoneycrispData = LocalStore<typeof honeycrispDefinition>;

export type Folder = RowOf<typeof honeycrispDefinition.tables.folders>;
export type Note = RowOf<typeof honeycrispDefinition.tables.notes>;

/**
 * Delete a folder after re-parenting the notes that were in it.
 *
 * Synchronous, and one pass rather than a stream: `rows` reads the CRDT that
 * is already in memory. A failed note update stops before the folder goes, so
 * the operation can be retried without knowingly leaving a dangling folder id.
 *
 * A note that vanished between the `rows` read and its own update is skipped
 * rather than raised: it is no longer in this folder, which is the outcome the
 * caller wanted, and another device deleting a note mid-pass is ordinary in a
 * synced document. Every other refusal means a declaration and this code
 * disagree, and that throws.
 *
 * A note this release cannot read is re-parented too, through its `raw`
 * payload. `nonconforming` returns those separately, and skipping them would leave a
 * note pointing at a folder that no longer exists while reporting success —
 * which is the silent damage nonconformance is supposed not to cause. An
 * `update` validates only the values it is given, so setting `folderId` on an
 * otherwise unreadable row is a legal write (ADR-0125).
 */
export function deleteHoneycrispFolder(
	data: Pick<HoneycrispData, 'tables' | 'transact'>,
	folderId: FolderId,
): void {
	const notes = data.tables.notes;
	const inFolder = [
		...notes.rows
			.filter((note) => note.folderId === folderId)
			.map((note) => note.id),
		...notes.nonconforming
			.filter((issue) => issue.raw.folderId === folderId)
			.map((issue) => issue.id),
	];
	// One commit for the whole re-parenting. Without it a folder holding fifty
	// notes cost fifty-one commits, fifty-one durable appends, and fifty-one
	// notifications to every list on screen, for one user action.
	data.transact(() => {
		for (const noteId of inFolder) {
			const { error } = data.tables.notes.update(noteId, { folderId: null });
			if (error !== null && error.name !== 'RowAbsent') throw error;
		}
		// Deleting an absent folder is a no-op fact, not an error.
		data.tables.folders.delete(folderId);
	});
}
