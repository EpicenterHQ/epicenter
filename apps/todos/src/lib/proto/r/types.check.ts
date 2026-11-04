// PROTOTYPE. Compile-time proof that the derived `App` and the context carry real types.
import type { World } from '../open.js';
import { type App, getApp } from './app.js';

type Expect<T extends true> = T;
export type Checks = [
	Expect<App['folder'] extends World['folder'] ? true : false>,
	Expect<App['label'] extends (count: number) => string ? true : false>,
	// SvelteKit's global `App` namespace still resolves beside the imported type.
	Expect<App.Error extends { message: string } ? true : false>,
];

export function read() {
	const { todos, label } = getApp();
	// @ts-expect-error label returns a string, so a typed read refuses a number.
	const wrong: number = label(todos.items.length);
	return wrong;
}
