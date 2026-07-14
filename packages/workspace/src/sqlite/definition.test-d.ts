/**
 * SQLite Workspace Definition Type Tests
 *
 * Locks the row, document-format, and KV nullability inference of the
 * terminal declaration API. Runtime recognition of the closed field palette
 * is covered separately in `definition.test.ts`.
 */

import { type Static, Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';
import { nullable } from '../document/nullable.js';
import {
	defineKv,
	defineTable,
	defineWorkspace,
	lockWorkspace,
	type RowFor,
	type WorkspaceDefinition,
} from './definition.js';
import { type DocumentFormat, document } from './document-format.js';
import { type BlobRef, field } from './field.js';
// @ts-expect-error — generated workspace ids are not a public authoring API
import { deriveWorkspaceId } from './index.js';

type NoteId = string & Brand<'NoteId'>;

const notes = defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
		folderId: nullable(field.string()),
		updatedAt: field.instant(),
		body: field.doc(document.plainText),
		summary: field.doc(document.plainText),
		attachment: field.blob(),
	},
});

const row: RowFor<typeof notes> = {
	id: 'note-1' as NoteId,
	title: 'Hello',
	folderId: null,
	updatedAt: null as unknown as RowFor<typeof notes>['updatedAt'],
	attachment: {
		hash: '0'.repeat(64),
		size: 1,
		mediaType: 'text/plain',
	},
};
const title: string = row.title;
const noteId: NoteId = row.id;
const folderId: string | null = row.folderId;
const attachment: BlobRef = row.attachment;
// @ts-expect-error: document declarations are not SQLite row cells
row.body;
const bodyDoc: DocumentFormat = notes.documents.body;
const summaryDoc: DocumentFormat = notes.documents.summary;
// @ts-expect-error — only declared document names exist
const missingDoc: DocumentFormat = notes.documents.missing;

const enabled = defineKv(field.boolean(), () => true);
const enabledValue: boolean = null as unknown as Static<typeof enabled.schema>;
const candidate = defineWorkspace({
	appId: 'notes',
	version: 1,
	tables: { notes },
	kv: { enabled },
});
// @ts-expect-error — source candidates cannot open storage before lock validation
const unlocked: WorkspaceDefinition = candidate;
const workspace = lockWorkspace(candidate, {
	format: 'epicenter.workspace-version-lock/1',
	appId: candidate.appId,
	versions: [candidate.proposedLockEntry],
});
void deriveWorkspaceId;

defineWorkspace({
	appId: 'notes',
	version: 1,
	// @ts-expect-error — applications cannot author an independent workspace id
	id: 'forged-workspace',
	tables: { notes },
});

// @ts-expect-error — table definitions expose immutable field maps
notes.fields.title = field.number();
// @ts-expect-error — table definitions expose immutable document maps
notes.documents.body = document.xmlFragment;
// @ts-expect-error — compiled column properties are immutable
notes.compiledColumns.title.kind = 'number';
// @ts-expect-error — KV definition properties are immutable
enabled.schema = field.number();
// @ts-expect-error — workspace definition properties are immutable
workspace.name = 'Renamed';
// @ts-expect-error — workspace table maps are immutable
workspace.tables.notes = notes;
// @ts-expect-error — workspace KV maps are immutable
workspace.kv.enabled = enabled;

const tableLookalike = {
	fields: notes.fields,
	columns: notes.columns,
	schema: notes.schema,
	documents: notes.documents,
	blobs: notes.blobs,
	compiledColumns: notes.compiledColumns,
};
defineWorkspace({
	appId: 'forged-table',
	version: 1,
	// @ts-expect-error — only defineTable products carry table-definition identity
	tables: { notes: tableLookalike },
});

const kvLookalike = {
	schema: enabled.schema,
	defaultValue: enabled.defaultValue,
};
defineWorkspace({
	appId: 'forged-kv',
	version: 1,
	tables: { notes },
	// @ts-expect-error — only defineKv products carry KV-definition identity
	kv: { enabled: kvLookalike },
});

// @ts-expect-error — every application table requires an id column
defineTable({ fields: { title: field.string() } });

defineTable({
	fields: {
		id: field.string(),
		// @ts-expect-error: field.doc accepts only the closed capability catalog
		body: field.doc('records'),
	},
});

const documentTable = defineTable({
	fields: {
		id: field.string(),
		body: field.doc(document.plainText),
	},
});
const bodyDocument: DocumentFormat = documentTable.documents.body;

// Nullable KV is allowed: the preference plane never rides the record wire,
// so null is an ordinary stored preference (ADR-0124).
const lastFolder = defineKv(nullable(field.string()), () => null);
const lastFolderValue: string | null = null as unknown as Static<
	typeof lastFolder.schema
>;

defineTable({
	fields: {
		id: field.string(),
		// @ts-expect-error — null-admitting table fields require the explicit nullable wrapper
		payload: field.json(Type.Unknown()),
	},
});

defineTable({
	fields: {
		id: field.string(),
		payload: nullable(field.json(Type.Unknown())),
	},
});

void title;
void noteId;
void folderId;
void attachment;
void bodyDoc;
void summaryDoc;
void missingDoc;
void enabledValue;
void unlocked;
void workspace;
void lastFolderValue;
void bodyDocument;
