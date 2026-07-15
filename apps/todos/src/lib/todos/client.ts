import { openTodosBrowser } from '../../../todos.browser';
import { createTodosState } from './state.svelte';

export const todos = await openTodosBrowser({ connection: { kind: 'local' } });
export const todosState = createTodosState(todos);

if (import.meta.hot) {
	import.meta.hot.dispose(() => {
		todosState[Symbol.dispose]();
		void todos[Symbol.asyncDispose]();
	});
}
