/**
 * Actions the header and the todo editor share: copy a path, and delete a
 * todo with a confirmation that names it and says whether its latest changes
 * are in no saved version.
 */

import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
import { toast } from '@epicenter/ui/sonner';
import { describeError } from '$lib/describe-error.js';
import { todoPath } from '$lib/todo-listing.js';
import type { Todos } from '$lib/todos.svelte.js';

export async function copyPath(path: string) {
	try {
		await navigator.clipboard.writeText(path);
		toast.success(`Copied ${path}`);
	} catch {
		toast.error('Could not copy the path', { description: path });
	}
}

/** What deleting the file at `path` loses, as Git status reports it now. */
async function history(todos: Todos, path: string) {
	const { data: observed } = await todos.git.status.fetch();
	if (observed === null)
		return 'Todos could not check whether its latest changes are in a saved version, so they may be lost.';
	return observed.changes.some((change) => change.path === path)
		? 'Its latest changes are in no saved version, so deleting it loses them. Save a version first to keep them in history.'
		: 'Its current text is in the last saved version.';
}

/**
 * Ask before deleting the todo `stem`, named by its `title` when it has one.
 * The delete runs after the file's queued writes, so it removes what the app
 * saved last; a file changed elsewhere since is refused.
 */
export async function confirmDelete(
	todos: Todos,
	stem: string,
	title: string | undefined,
	onDeleted?: () => void,
) {
	const path = todoPath(stem);
	confirmationDialog.open({
		title: `Delete “${title?.trim() ? title : `${stem}.md`}”?`,
		description: `This deletes ${path} from the folder. ${await history(todos, path)}`,
		confirm: { text: 'Delete', variant: 'destructive' },
		async onConfirm() {
			const { error } = await todos.rows.remove(stem);
			if (error !== null)
				toast.error(`Could not delete ${path}`, {
					description: describeError(error),
				});
			else onDeleted?.();
		},
	});
}
