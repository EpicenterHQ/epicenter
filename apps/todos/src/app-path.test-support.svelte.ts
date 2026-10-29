/**
 * Test helper: the shell's side of the app contract for a mounted Todos.
 * The app's path is reactive state that `navigate` moves, as the shell's
 * URL does; nothing else changes it.
 */
let path = $state('/');

/** Where the app is, as the shell would pass it. */
export const at = {
	get path() {
		return path;
	},
};

/** The shell's `navigate`: the path moves at once. */
export async function navigate(next: string) {
	path = next;
}

/** Start the next test at `next`. */
export function resetPath(next = '/') {
	path = next;
}
