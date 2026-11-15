/**
 * What Tasks' pages watch and what they change, as TanStack options over the
 * actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.list())` and writes with
 * `createMutation(() => writes.set)`; App.svelte's QueryClient refreshes
 * every read after each write.
 */
import { type ActionOutput, connect } from '@epicenter/app/client';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type { MutationFunctionContext } from '@tanstack/svelte-query';
import type tasksApp from '../../../epicenter.js';

type Actions = (typeof tasksApp)['actions'];

const app = connect<typeof tasksApp>();

export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });

const mutations = resultMutations(['tasks'], {
	add: app.add,
	set: app.set,
	note: app.note,
	delete: app.delete,
});

/** A row of `tasks list`: a task's path and fields, without its notes; `problems` when its file does not fit. */
export type Task = ActionOutput<Actions['list']>[number];

/** Keep the saved record visible even when the following read fails. */
const saved = {
	onSuccess: async (
		file: ActionOutput<Actions['get']>,
		_input: unknown,
		_previous: unknown,
		{ client }: MutationFunctionContext,
	) => {
		const { queryKey } = reads.get({ path: file.path });
		const listKey = reads.list().queryKey;
		await Promise.all([
			client.cancelQueries({ queryKey, exact: true }),
			client.cancelQueries({ queryKey: listKey, exact: true }),
		]);
		client.setQueryData(queryKey, file);
		// Collection list rows omit the body and undeclared front matter.
		const { body: _body, other: _other, ...row } = file;
		client.setQueryData<ActionOutput<Actions['list']>>(listKey, (rows) => rows && (
			rows.some((item) => item.path === file.path)
				? rows.map((item) => item.path === file.path ? row : item)
				: [...rows, row]
		));
	},
};

export const writes = {
	...mutations,
	delete: {
		...mutations.delete,
		onSuccess: async (_result, { path }, _previous, { client }) => {
			const { queryKey } = reads.get({ path });
			const listKey = reads.list().queryKey;
			await Promise.all([
				client.cancelQueries({ queryKey, exact: true }),
				client.cancelQueries({ queryKey: listKey, exact: true }),
			]);
			client.setQueryData<ActionOutput<Actions['list']>>(listKey, (rows) =>
				rows?.filter((row) => row.path !== path));
			client.removeQueries({ queryKey, exact: true });
		},
	} satisfies typeof mutations.delete,
	add: { ...mutations.add, ...saved },
	set: { ...mutations.set, ...saved },
	note: { ...mutations.note, ...saved },
};
