import { asPrincipalId } from '@epicenter/identity';
import {
	inspectBrowserWorkspace,
	openBrowserWorkspace,
	type StandaloneWorkspace,
	type WorkspaceReplica,
} from '@epicenter/workspace/sqlite/browser';
import versionLock from '../../../workspace-version-lock.json' with {
	type: 'json',
};
import { workspaceDefinition } from './definition.js';
import WorkspaceWorker from './workspace.worker?worker';

type Note = { id: string; title: string; archived: boolean };
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
const workspaceKind = new URLSearchParams(location.search).has('replica')
	? 'replica'
	: 'standalone';
const syncOrigin = new URL(location.href);
syncOrigin.port = '5199';
const authority =
	workspaceKind === 'replica'
		? ({
				kind: 'server',
				baseURL: syncOrigin.origin,
				principalId: asPrincipalId('browser-smoke'),
			} as const)
		: ({ kind: 'local' } as const);

const hasPredecessors = versionLock.versions.some(
	({ version }) => version < workspaceDefinition.version,
);
const serverCapabilities = {
	openWebSocket: (url: string | URL, protocols?: string[]) =>
		new WebSocket(url, protocols),
	onReconnectSignal: (_reconnect: () => void) => () => undefined,
};
let workspace: Workspace | undefined;

function requireApp(): HTMLElement {
	const element = document.querySelector('main');
	if (!(element instanceof HTMLElement)) {
		throw new Error('Current version root is missing');
	}
	return element;
}

function renderState(
	state: 'loading' | 'invalid' | 'error' | 'ready',
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

function renderGate(): void {
	document.body.dataset.state = 'gate';
	app.replaceChildren();
	const heading = document.createElement('h1');
	heading.textContent = 'Start the current version?';
	const description = document.createElement('p');
	description.textContent =
		'This version starts with independent data. Your previous version stays unchanged.';
	const actions = document.createElement('div');
	actions.className = 'actions';
	const start = document.createElement('button');
	start.type = 'button';
	start.textContent = 'Start current version';
	const previous = document.createElement('a');
	previous.href = `/previous/v1/${location.search}`;
	previous.textContent = 'Continue with previous version';
	start.addEventListener(
		'click',
		() => {
			start.disabled = true;
			renderState(
				'loading',
				'Starting current version',
				"Creating version 2's separate data space.",
			);
			openCurrent().catch(renderOperationalError);
		},
		{ once: true },
	);
	actions.append(start, previous);
	app.append(heading, description, actions);
}

async function openCurrent(): Promise<void> {
	const options = { onObserverError: reportError };
	workspace =
		workspaceKind === 'replica'
			? await openBrowserWorkspace(workspaceDefinition, {
					...options,
					connection: {
						kind: 'server',
						baseURL: syncOrigin.origin,
						principalId: asPrincipalId('browser-smoke'),
						fetch,
						...serverCapabilities,
					},
					worker: () => new WorkspaceWorker(),
				})
			: await openBrowserWorkspace(workspaceDefinition, {
					...options,
					connection: { kind: 'local' },
					worker: () => new WorkspaceWorker(),
				});
	window.versionTwoSmoke = {
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
		'Current version ready',
		'Version 2 is open in its separate data space.',
	);
}

function getWorkspace(): Workspace {
	if (!workspace) throw new Error('Version two is not open');
	return workspace;
}

function identity() {
	return {
		workspaceId: workspaceDefinition.workspaceId,
		kvDocumentGuid: workspaceDefinition.kvDocumentGuid,
		childDocumentGuid:
			getWorkspace().tables.notes.docs.body.guid('identity-proof-row'),
	};
}

function renderOperationalError(cause: unknown): void {
	const message = cause instanceof Error ? cause.message : String(cause);
	renderState('error', 'Current version could not open', message);
}

renderState(
	'loading',
	'Checking this version',
	"Looking for version 2's initialized data space.",
);
try {
	const inspection = await inspectBrowserWorkspace(workspaceDefinition, {
		authority,
		worker: () => new WorkspaceWorker(),
	});
	switch (inspection.status) {
		case 'initialized':
			await openCurrent();
			break;
		case 'absent':
			if (hasPredecessors) renderGate();
			else await openCurrent();
			break;
		case 'invalid':
			renderState(
				'invalid',
				'Current data cannot open',
				`Version 2 storage exists but is invalid: ${inspection.reason}`,
			);
			break;
	}
} catch (cause) {
	renderOperationalError(cause);
}

declare global {
	interface Window {
		versionTwoSmoke: {
			create(note: Omit<Note, 'id'>): Promise<Note>;
			get(id: string): Promise<Note | null>;
			list(): Promise<Note[]>;
			identity(): ReturnType<typeof identity>;
			dispose(): Promise<void>;
		};
	}
}
