/**
 * Honeycrisp's pure table and child-document vocabulary. Isomorphic: no
 * IndexedDB, WebSockets, SQLite files, Svelte state, or process lifecycle.
 *
 * Distribution: `apps/honeycrisp/package.json` exports this file as the
 * `@epicenter/honeycrisp` package root. Browser code and tests import from
 * here. The locked workspace candidate composes these tables separately.
 *
 * Composition lives elsewhere:
 *  - `apps/honeycrisp/src/lib/workspace/browser.ts` -> `openHoneycrispBrowser({ auth })`
 */

import {
	defineTable,
	document,
	field,
	type Id,
	nullable,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import type { Brand } from 'wellcrafted/brand';

// ─── Branded IDs ──────────────────────────────────────────────────────────────

/** Framework-allocated note row ID. */
export type NoteId = Id & Brand<'NoteId'>;

/**
 * Syntactic sugar for `value as NoteId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as NoteId` should appear.
 */
export const asNoteId = (value: string): NoteId => value as NoteId;

/** Framework-allocated folder row ID. */
export type FolderId = Id & Brand<'FolderId'>;

/**
 * Syntactic sugar for `value as FolderId`. The constrained `string` parameter
 * is what earns it over a raw `as` cast (callers can't widen to `unknown`).
 * The only place in the codebase where `as FolderId` should appear.
 */
export const asFolderId = (value: string): FolderId => value as FolderId;

// ─── Tables ───────────────────────────────────────────────────────────────────

/**
 * Folders table: organizational containers for notes.
 *
 * Each folder has a name, optional emoji icon, and sort order for manual
 * reordering in the sidebar. Notes reference folders via `folderId`.
 */
export const foldersTable = defineTable({
	fields: {
		id: field.id<FolderId>(),
		name: field.string(),
		icon: nullable(field.string()),
		sortOrder: field.number(),
	},
});
export type Folder = RowFor<typeof foldersTable>;

/**
 * Notes table: individual notes with rich-text bodies.
 *
 * Each note belongs to an optional folder (unfiled if `folderId` is null),
 * has a title auto-populated from the first line of content, a preview for the
 * list view, and can be pinned to appear at the top of the note list.
 *
 * `deletedAt` is `null` for active notes and an `InstantString` for deleted
 * notes. `wordCount` is computed on each editor update.
 *
 * The Y.XmlFragment document (`body`) lives in a separate Y.Doc per note,
 * declared as a child doc on this table.
 */
export const notesTable = defineTable({
	fields: {
		id: field.id<NoteId>(),
		folderId: nullable(field.reference<FolderId>('folders')),
		title: field.string(),
		preview: field.string(),
		pinned: field.boolean(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		deletedAt: nullable(field.instant()),
		wordCount: nullable(field.number()),
		body: field.doc(document.xmlFragment),
	},
});
export type Note = RowFor<typeof notesTable>;
