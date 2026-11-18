/**
 * What Tasks' pages watch and what they change, as TanStack options over the
 * actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.list())` and writes with
 * `createMutation(() => writes.patch)`; App.svelte's QueryClient refreshes
 * every read after each write.
 */
import { type ActionOutput, connect } from '@epicenter/app/client';
import { Ok } from 'wellcrafted/result';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type { MutationFunctionContext } from '@tanstack/svelte-query';
import type tasksApp from '../../../epicenter.js';

type Actions = ReturnType<typeof tasksApp>['actions'];

const app = connect<typeof tasksApp>();

export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });

const mutations = resultMutations(['tasks'], {
	add: app.add,
	patch: app.patch,
	// Notes quote what was there through the generated edit verb; empty notes have nothing to quote, so they patch the body.
	edit: ({ id, old, new: replacement }: { id: string; old: string; new: string }) => old === '' ? app.patch({ id, body: replacement }) : app.edit({ id, old, new: replacement }),
	delete: app.delete,
});

/** A row of `tasks list`: one Result per file, with fitting fields or a Misfit to repair, including notes. */
export type TaskRowResult = ActionOutput<Actions['list']>[number];
export type Task = NonNullable<TaskRowResult['data']>;

/** Keep the saved record visible even when the following read fails. */
const saved = {
	onSuccess: async (
		file: ActionOutput<Actions['get']>,
		_input: unknown,
		_previous: unknown,
		{ client }: MutationFunctionContext,
	) => {
		const { queryKey } = reads.get({ id: file.id });
		const listKey = reads.list().queryKey;
		await Promise.all([
			client.cancelQueries({ queryKey, exact: true }),
			client.cancelQueries({ queryKey: listKey, exact: true }),
		]);
		client.setQueryData(queryKey, file);
		// List and get return the same record.
		client.setQueryData<ActionOutput<Actions['list']>>(listKey, (rows) => rows && (
			rows.some((item) => rowPath(item) === file.path)
				? rows.map((item) => rowPath(item) === file.path ? Ok(file) : item)
				: [...rows, Ok(file)]
		));
	},
};

export const writes = {
	...mutations,
	delete: {
		...mutations.delete,
		onSuccess: async (_result, { id }, _previous, { client }) => {
			const { queryKey } = reads.get({ id });
			const listKey = reads.list().queryKey;
			await Promise.all([
				client.cancelQueries({ queryKey, exact: true }),
				client.cancelQueries({ queryKey: listKey, exact: true }),
			]);
			client.setQueryData<ActionOutput<Actions['list']>>(listKey, (rows) =>
				rows?.filter((row) => rowPath(row) !== `data/tasks/${id}.md`));
			client.removeQueries({ queryKey, exact: true });
		},
	} satisfies typeof mutations.delete,
	add: { ...mutations.add, ...saved },
	patch: { ...mutations.patch, ...saved },
	edit: { ...mutations.edit, ...saved },
};

/** Both readable and malformed rows have a path. */
export const rowPath = (row: ActionOutput<Actions['list']>[number]) => row.error === null ? row.data.path : row.error.path;
