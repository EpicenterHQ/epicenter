/** The test page's app definition. */
import { Type } from 'typebox';
import { defineApp } from '../../src/api/index.js';

export const todosApp = defineApp({
	todos: {
		path: 'todos/{stem}.md',
		schema: Type.Object({ title: Type.String(), done: Type.Boolean() }),
	},
});
