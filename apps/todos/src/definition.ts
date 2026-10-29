import { defineManifest } from '@epicenter/app';
import { defineApp } from '@epicenter/repository';
import { Type } from 'typebox';

/**
 * Markdown rows in `todos/<id>.md`; a schema interprets, never authorizes
 * writes. The native CLI and the schema export still read a folder with it.
 */
export const todosTables = {
	todos: Type.Object({ title: Type.String(), done: Type.Boolean() }),
};

/** The app's lens over its repository: each todo is `todos/<stem>.md`. */
export const todosApp = defineApp({
	todos: { path: 'todos/{stem}.md', schema: todosTables.todos },
});

/** Todos as an app (ADR-0694): served at `todos.epicenter.so`, over `todos/`. */
export const manifest = defineManifest({ name: 'Todos', hostname: 'todos.epicenter.so', collections: todosApp });
