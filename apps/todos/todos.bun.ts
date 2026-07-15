import { openStandaloneWorkspace } from '@epicenter/workspace/sqlite/bun';
import { todosWorkspaceDefinition } from './src/versions/v1/definition.js';
import { createTodosActions } from './todos.js';

/** Open Todos version 1 as one Bun-owned standalone SQLite workspace. */
export async function openTodosBun({ path }: { path: string }) {
	const workspace = await openStandaloneWorkspace(todosWorkspaceDefinition, {
		storage: { kind: 'bun', path },
		onObserverError: reportError,
	});
	return {
		...workspace,
		actions: createTodosActions(workspace),
	};
}
