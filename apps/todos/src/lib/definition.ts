import { Type } from 'typebox';

/** Markdown rows in `todos/<id>.md`; a schema interprets, never authorizes writes. */
export const todosTables = {
	todos: Type.Object({ title: Type.String(), done: Type.Boolean() }),
};
