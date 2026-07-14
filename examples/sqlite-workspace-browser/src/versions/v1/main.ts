import {
	openStandaloneWorkspace,
	openWorkspaceReplica,
	type StandaloneWorkspace,
	type WorkspaceReplica,
} from '@epicenter/workspace/sqlite/browser';
import * as Y from 'yjs';
import { workspaceDefinition } from './definition.js';
import ReplicaWorker from './replica.worker?worker';
import StandaloneWorker from './standalone.worker?worker';

type Note = { id: string; title: string };
type Workspace =
	| StandaloneWorkspace<
			typeof workspaceDefinition.tables,
			typeof workspaceDefinition.kv
	  >
	| WorkspaceReplica<
			typeof workspaceDefinition.tables,
			typeof workspaceDefinition.kv
	  >;

const app = requireApp();

const preferencesDoc = new Y.Doc({
	guid: workspaceDefinition.kvDocumentGuid,
});
let workspace: Workspace | undefined;

function requireApp(): HTMLElement {
	const element = document.querySelector('main');
	if (!(element instanceof HTMLElement)) {
		throw new Error('Historical version root is missing');
	}
	return element;
}

function renderState(
	state: 'loading' | 'error' | 'ready',
	title: string,
	detail: string,
): void {
	document.body.dataset.state = state;
	app.replaceChildren();
	const heading = document.createElement('h1');
	heading.textContent = title;
	const description = document.createElement('p');
	description.textContent = detail;
	app.append(heading, description);
}

async function open(): Promise<void> {
	const options = {
		kv: { doc: preferencesDoc },
		onObserverError: reportError,
	};
	workspace = new URLSearchParams(location.search).has('replica')
		? await openWorkspaceReplica(workspaceDefinition, {
				...options,
				worker: () => new ReplicaWorker(),
			})
		: await openStandaloneWorkspace(workspaceDefinition, {
				...options,
				worker: () => new StandaloneWorker(),
			});
}

function getWorkspace(): Workspace {
	if (!workspace) throw new Error('Version one is not open');
	return workspace;
}

function identity() {
	return {
		workspaceId: workspaceDefinition.workspaceId,
		kvDocumentGuid: preferencesDoc.guid,
		childDocumentGuid:
			getWorkspace().tables.notes.docs.body.guid('identity-proof-row'),
	};
}

renderState(
	'loading',
	'Opening previous version',
	'Version 1 keeps its own records and remains writable.',
);
try {
	await open();
	window.versionOneSmoke = {
		create(note) {
			return getWorkspace().tables.notes.create(note);
		},
		get(id) {
			return getWorkspace().tables.notes.get(id);
		},
		list() {
			return getWorkspace().tables.notes.list({ orderBy: 'id' });
		},
		identity,
		async dispose() {
			await workspace?.[Symbol.asyncDispose]();
			workspace = undefined;
		},
	};
	document.body.dataset.workspaceId = workspaceDefinition.workspaceId;
	renderState(
		'ready',
		'Previous version ready',
		'Version 1 is open in its original data space.',
	);
} catch (cause) {
	const message = cause instanceof Error ? cause.message : String(cause);
	renderState('error', 'Previous version could not open', message);
}

declare global {
	interface Window {
		versionOneSmoke: {
			create(note: Omit<Note, 'id'>): Promise<Note>;
			get(id: string): Promise<Note | null>;
			list(): Promise<Note[]>;
			identity(): ReturnType<typeof identity>;
			dispose(): Promise<void>;
		};
	}
}
