/**
 * SQLite Workspace Definition Type Tests
 *
 * Locks the row, document-format, and KV nullability inference of the
 * terminal declaration API. Runtime recognition of the closed field palette
 * is covered separately in `definition.test.ts`.
 */

import { field } from '@epicenter/field';
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
// @ts-expect-error — generated workspace ids are not a public authoring API
import { applicationWorkspaceId } from './index.js';

type NoteId = string & Brand<'NoteId'>;

const notes = defineTable({
	fields: {
		id: field.string<NoteId>(),
		title: field.string(),
		folderId: nullable(field.string()),
		updatedAt: field.instant(),
	},
	documents: {
		body: document.plainText,
		summary: document.plainText,
	},
});

const row: RowFor<typeof notes> = {
	id: 'note-1' as NoteId,
	title: 'Hello',
	folderId: null,
	updatedAt: null as unknown as RowFor<typeof notes>['updatedAt'],
};
const title: string = row.title;
const noteId: NoteId = row.id;
const folderId: string | null = row.folderId;
const bodyDoc: DocumentFormat = notes.documents.body;
const summaryDoc: DocumentFormat = notes.documents.summary;
// @ts-expect-error — only declared document names exist
const missingDoc: DocumentFormat = notes.documents.missing;

const enabled = defineKv(field.boolean(), () => true);
const enabledValue: boolean = null as unknown as Static<typeof enabled.schema>;
const candidate = defineWorkspace({
	appId: 'notes',
	dataVersion: 1,
	tables: { notes },
	kv: { enabled },
});
// @ts-expect-error — source candidates cannot open storage before lock validation
const unlocked: WorkspaceDefinition = candidate;
const workspace = lockWorkspace(candidate, {
	format: 'epicenter.application-data-version-lock/1',
	appId: candidate.appId,
	versions: [candidate.proposedLockEntry],
});
void applicationWorkspaceId;

defineWorkspace({
	appId: 'notes',
	dataVersion: 1,
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
	schema: notes.schema,
	documents: notes.documents,
	compiledColumns: notes.compiledColumns,
};
defineWorkspace({
	appId: 'forged-table',
	dataVersion: 1,
	// @ts-expect-error — only defineTable products carry table-definition identity
	tables: { notes: tableLookalike },
});

const kvLookalike = {
	schema: enabled.schema,
	defaultValue: enabled.defaultValue,
};
defineWorkspace({
	appId: 'forged-kv',
	dataVersion: 1,
	tables: { notes },
	// @ts-expect-error — only defineKv products carry KV-definition identity
	kv: { enabled: kvLookalike },
});

// @ts-expect-error — every application table requires an id column
defineTable({ fields: { title: field.string() } });

defineTable({
	fields: { id: field.string() },
	// @ts-expect-error — documents accept only the closed capability catalog
	documents: { body: 'records' },
});

const overlappingNames = defineTable({
	fields: { id: field.string(), body: field.string() },
	documents: { body: document.plainText },
});
const bodyCell: string = null as unknown as RowFor<
	typeof overlappingNames
>['body'];
const bodyDocument: DocumentFormat = overlappingNames.documents.body;

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
void bodyDoc;
void summaryDoc;
void missingDoc;
void enabledValue;
void unlocked;
void workspace;
void lastFolderValue;
void bodyCell;
void bodyDocument;
