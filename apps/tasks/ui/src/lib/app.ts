/**
 * What Tasks' pages watch and what they change, as TanStack options over the
 * actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.list())` and writes with
 * `createMutation(() => writes.set)`.
 */
import { type ActionInput, type ActionOutput, connect, createQueryClient } from '@epicenter/app/client';
import { useMutationState } from '@tanstack/svelte-query';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type tasksApp from '../../../epicenter.js';

type Actions = (typeof tasksApp)['actions'];

const app = connect<typeof tasksApp>('tasks');

/** The layout's QueryClient: every read refreshes after a write and whenever Tasks' files change. */
export const queryClient = createQueryClient('tasks');

export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });

export const writes = resultMutations(['tasks'], {
	add: app.add,
	set: app.set,
	edit: app.edit,
	delete: app.delete,
});

/** A row of `tasks list`: a task's path and fields, without its notes; `problems` when its file does not fit. */
export type Task = ActionOutput<Actions['list']>[number];

/** The fields `tasks set` takes besides the path. */
export type TaskChanges = Omit<ActionInput<Actions['set']>, 'path'>;

/**
 * What every `set` still on its way was asked to change, oldest first, so a
 * page shows a change before it lands. Call it where a component starts.
 */
export function sendingSets() {
	return useMutationState({
		filters: { mutationKey: writes.set.mutationKey, status: 'pending' },
		select: (mutation) => mutation.state.variables as ActionInput<Actions['set']>,
	});
}
