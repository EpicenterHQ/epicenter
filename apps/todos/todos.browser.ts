import type { WorkspaceConnection } from '@epicenter/workspace/sqlite';
import { openBrowserWorkspace } from '@epicenter/workspace/sqlite/browser';
import { todosWorkspaceDefinition } from './src/versions/v1/definition.js';
import WorkspaceWorker from './src/versions/v1/workspace.worker?worker';
import { createTodosActions } from './todos.js';

export type OpenTodosBrowserOptions = { connection: WorkspaceConnection };

/** Open Todos version 1 against exactly one boot-time authority. */
export async function openTodosBrowser(options: OpenTodosBrowserOptions) {
	const workspace = await openBrowserWorkspace(todosWorkspaceDefinition, {
		worker: () => new WorkspaceWorker(),
		onObserverError: reportError,
		connection: options.connection,
	});
	return {
		...workspace,
		actions: createTodosActions(workspace),
	};
}

export type TodosBrowser = Awaited<ReturnType<typeof openTodosBrowser>>;
