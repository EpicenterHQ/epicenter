import { defineWorkspace } from '@epicenter/workspace/sqlite';
import { TODOS_APP_ID, todosTable } from '../../../todos.js';

export const workspaceCandidate = defineWorkspace({
	appId: TODOS_APP_ID,
	version: 1,
	name: 'Todos',
	tables: { todos: todosTable },
});
