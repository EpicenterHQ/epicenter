import type { WorkspaceAuthority } from '@epicenter/workspace/sqlite';
import {
	type BrowserWorkspaceFetch,
	openBrowserWorkspace,
} from '@epicenter/workspace/sqlite/browser';
import { todosWorkspaceDefinition } from './src/versions/v1/definition.js';
import WorkspaceWorker from './src/versions/v1/workspace.worker?worker';
import { createTodosActions } from './todos.js';

export type OpenTodosBrowserOptions =
	| {
			authority: Extract<WorkspaceAuthority, { kind: 'local' }>;
			fetch?: never;
	  }
	| {
			authority: Extract<WorkspaceAuthority, { kind: 'server' }>;
			fetch: BrowserWorkspaceFetch;
	  };

/** Open Todos version 1 against exactly one boot-time authority. */
export async function openTodosBrowser(options: OpenTodosBrowserOptions) {
	const common = {
		worker: () => new WorkspaceWorker(),
		onObserverError: reportError,
	};
	if (options.authority.kind === 'server') {
		const fetch = options.fetch;
		if (!fetch)
			throw new TypeError('A server workspace authority requires fetch');
		const workspace = await openBrowserWorkspace(todosWorkspaceDefinition, {
			...common,
			authority: options.authority,
			fetch,
		});
		return {
			...workspace,
			actions: createTodosActions(workspace),
		};
	}
	const workspace = await openBrowserWorkspace(todosWorkspaceDefinition, {
		...common,
		authority: options.authority,
	});
	return {
		...workspace,
		actions: createTodosActions(workspace),
	};
}

export type TodosBrowser = Awaited<ReturnType<typeof openTodosBrowser>>;
