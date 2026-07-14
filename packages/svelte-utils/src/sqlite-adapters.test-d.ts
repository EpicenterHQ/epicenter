import type { Kv } from '@epicenter/workspace';
import type { ApplicationTable, AsyncTable } from '@epicenter/workspace/sqlite';
import {
	defineKv,
	defineTable,
	field,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import { fromKv } from './from-kv.svelte.js';
import { fromTable } from './from-table.svelte.js';

const kvDefinitions = {
	theme: defineKv(
		field.select(['light', 'dark']),
		(): 'light' | 'dark' => 'light',
	),
	count: defineKv(field.integer(), () => 0),
};
declare const kv: Kv<typeof kvDefinitions>;

const theme = fromKv(kv, 'theme');
const currentTheme: 'light' | 'dark' = theme.current;
theme.current = 'dark';
// @ts-expect-error — the binding preserves the selected KV key's value type
theme.current = 1;
// @ts-expect-error — undeclared KV keys are rejected
fromKv(kv, 'missing');

const notesDefinition = defineTable({
	fields: {
		id: field.id(),
		title: field.string(),
	},
});
type Note = RowFor<typeof notesDefinition>;
declare const notes: ApplicationTable<Note>;

const noteView = fromTable(notes);
const notesList: readonly Note[] = noteView.all;
const note: Note | undefined = noteView.byId('note-1');
// @ts-expect-error — exact-schema SQLite views do not expose Yjs repair buckets
noteView.nonconforming;

void currentTheme;
void notesList;
void note;

declare const asyncNotes: AsyncTable<Note>;
const created: Promise<Note> = asyncNotes.create({ title: 'Created' });
const preserved: Promise<Note> = asyncNotes.create({
	id: 'caller-supplied',
	title: 'Preserved',
});
const asyncNoteView = fromTable(asyncNotes);
const asyncNotesList: readonly Note[] = asyncNoteView.all;
const asyncNote: Note | undefined = asyncNoteView.byId('note-1');
const notesReady: Promise<void> = asyncNoteView.whenReady;

void asyncNotesList;
void asyncNote;
void notesReady;
void created;
void preserved;
