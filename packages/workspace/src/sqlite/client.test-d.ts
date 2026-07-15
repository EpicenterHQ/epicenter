/**
 * SQLite Workspace Client Type Tests
 *
 * Locks default ID allocation and explicit ID preservation at the public async
 * and batch table boundaries. Returned identities retain the brand declared by
 * the table schema.
 */

import { asPrincipalId } from '@epicenter/identity';
import type { Brand } from 'wellcrafted/brand';
import type { Id } from '../shared/id.js';
import type { WorkspaceConnection } from '../workspace-connection.js';
import {
	type OpenBrowserLocalWorkspaceOptions as BrowserOpenOptions,
	openBrowserWorkspace,
} from './browser.js';
import {
	type OpenStandaloneWorkspaceOptions as BunOpenOptions,
	openStandaloneWorkspace as openBunWorkspace,
} from './bun.js';
import type {
	AsyncTable,
	AsyncWorkspace,
	WorkspaceServicePort,
	WorkspaceWriteBatch,
} from './client.js';
import { createWorkspaceClient } from './client.js';
import { defineTable, type RowFor } from './definition.js';
import type {
	WorkspaceDocumentOpener,
	WorkspaceDocumentRuntime,
} from './document-client.js';
import { document } from './document-format.js';
import { field } from './field.js';
import { defineTestWorkspace as defineWorkspace } from './test-workspace.js';

type NoteId = Id & Brand<'NoteId'>;
type RecordingId = Id & Brand<'RecordingId'>;

const notes = defineTable({
	fields: {
		id: field.id<NoteId>(),
		title: field.string(),
	},
});
type Note = RowFor<typeof notes>;

declare const table: AsyncTable<Note>;
declare const batch: WorkspaceWriteBatch<{ notes: typeof notes }>;

const created: Promise<Note> = table.create({ title: 'Created' });
const allocatedId: NoteId = batch.tables.notes.create({ title: 'Batched' });
const existing = null as unknown as Note;

const preserved: Promise<Note> = table.create({
	id: 'caller-chosen' as NoteId,
	title: 'Preserved',
});
const recreated: Promise<Note> = table.create(existing);
const batchPreservedId: NoteId = batch.tables.notes.create(existing);

void created;
void allocatedId;
void preserved;
void recreated;
void batchPreservedId;

const notesWithDocuments = defineTable({
	fields: {
		id: field.id<NoteId>(),
		title: field.string(),
		body: field.doc(document.plainText),
	},
});
const workspaceWithDocumentsDefinition = defineWorkspace({
	appId: 'client-type-test',
	tables: { notes: notesWithDocuments },
});
declare const tableWithDocuments: AsyncTable<
	RowFor<typeof notesWithDocuments>,
	typeof notesWithDocuments.documents,
	WorkspaceDocumentOpener
>;
declare const documentOpener: WorkspaceDocumentOpener;
declare const documentRuntime: WorkspaceDocumentRuntime;
declare const noteId: NoteId;
declare const recordingId: RecordingId;

const currentBody = tableWithDocuments.docs.body.open(noteId);
const currentReady: Promise<void> = currentBody.whenReady;
type CurrentBodyValue = ReturnType<typeof currentBody.content.read>;
const currentBodyValue: CurrentBodyValue = 'current';

tableWithDocuments.docs.body.guid(noteId);
// @ts-expect-error: current table documents retain their owning row-id brand
tableWithDocuments.docs.body.open(recordingId);
// @ts-expect-error: guid derivation retains the same owning row-id brand
tableWithDocuments.docs.body.guid(recordingId);

declare const guidOnlyTable: AsyncTable<
	RowFor<typeof notesWithDocuments>,
	typeof notesWithDocuments.documents
>;
declare const workspaceWithoutDocuments: AsyncWorkspace<{
	notes: typeof notesWithDocuments;
}>;
// @ts-expect-error: historical document opening is not a workspace surface
workspaceWithoutDocuments.documents;
guidOnlyTable.docs.body.guid(noteId);
// @ts-expect-error: opening requires a composed document runtime
guidOnlyTable.docs.body.open(noteId);

declare const servicePort: WorkspaceServicePort;
createWorkspaceClient(
	workspaceWithDocumentsDefinition,
	servicePort,
	documentOpener,
);
// @ts-expect-error: a document-enabled client requires the runtime argument
createWorkspaceClient<
	{ notes: typeof notesWithDocuments },
	WorkspaceDocumentOpener
>(workspaceWithDocumentsDefinition, servicePort);

const browserWithDocuments: BrowserOpenOptions = {
	connection: { kind: 'local' },
	worker: () => null as never,
	onObserverError() {},
};
const bunWithDocuments: BunOpenOptions<WorkspaceDocumentRuntime> = {
	storage: { kind: 'memory' },
	documents: documentRuntime,
	onObserverError() {},
};
// @ts-expect-error: a non-undefined runtime generic makes documents required
const bunMissingDocuments: BunOpenOptions<WorkspaceDocumentRuntime> = {
	storage: { kind: 'memory' },
	onObserverError() {},
};
const browserOpen = openBrowserWorkspace(workspaceWithDocumentsDefinition, {
	connection: { kind: 'local' },
	worker: () => null as never,
	onObserverError() {},
});
declare const selectedConnection: WorkspaceConnection;
const selectedAuthorityBrowserOpen = openBrowserWorkspace(
	workspaceWithDocumentsDefinition,
	{
		connection: selectedConnection,
		worker: () => null as never,
		onObserverError() {},
	},
);
// @ts-expect-error: an explicit server connection requires transport capabilities
openBrowserWorkspace(workspaceWithDocumentsDefinition, {
	connection: {
		kind: 'server',
		baseURL: 'https://api.example.com',
		principalId: asPrincipalId('principal-1'),
	},
	worker: () => null as never,
	onObserverError() {},
});
// @ts-expect-error: browser openings expose only table-owned document opening
browserOpen.then((workspace) => workspace.documents);
const bunOpen = openBunWorkspace(workspaceWithDocumentsDefinition, {
	storage: { kind: 'memory' },
	documents: documentRuntime,
	onObserverError() {},
});
// @ts-expect-error: Bun openings expose only table-owned document opening
bunOpen.then((workspace) => workspace.documents);

void currentBody;
void currentReady;
void currentBodyValue;
void browserWithDocuments;
void selectedAuthorityBrowserOpen;
void bunWithDocuments;
void bunMissingDocuments;
