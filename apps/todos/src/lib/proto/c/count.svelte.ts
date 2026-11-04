// PROTOTYPE. A `.svelte.ts` helper that reads the world from context: works
// only when called during a component's setup.
import { getWorld } from './world.js';

export function openCount() {
	const { todos } = getWorld();
	return {
		get current() {
			return todos.items.filter((todo) => !todo.done).length;
		},
	};
}
