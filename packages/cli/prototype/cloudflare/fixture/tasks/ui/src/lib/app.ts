/**
 * What Tasks' pages watch and what they change, as TanStack options over the
 * actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.list())` and writes with
 * `createMutation(() => writes.set)`; App.svelte's QueryClient refreshes
 * every read after each write.
 */
import {
	type ActionInput,
	type ActionOutput,
	connect,
} from '@epicenter/app/client';
import { Ok } from 'wellcrafted/result';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type { MutationFunctionContext } from '@tanstack/svelte-query';
import type tasksApp from '../../../epicenter.js';

type Actions = (typeof tasksApp)['actions'];

const app = connect<typeof tasksApp>({
	app: 'tasks',
	url:
		(globalThis as typeof globalThis & { __EPICENTER_APP_URL__?: string })
			.__EPICENTER_APP_URL__ ?? location.pathname,
});

export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });

/** The editors quote the whole notes body. After an uncertain save, check the submitted fields against the file. */
async function save(input: ActionInput<Actions['set']>) {
	const result = await app.set(input);
	if (result.error === null) return result;

	const { time, was: _was, edit, ...fields } = input;
	const current = await app.get({ time });
	if (current.error !== null) return result;
	const record: Record<string, unknown> = current.data;
	const wanted = Object.entries({ ...fields, ...(edit && { body: edit.new }) });
	return wanted.length > 0 &&
		wanted.every(([field, value]) => (record[field] ?? null) === value)
		? current
		: result;
}

const mutations = resultMutations(['tasks'], {
	add: app.add,
	set: save,
	// Body edits use the generated set verb and its atomic quote guard.
	edit: ({
		time,
		old,
		new: replacement,
	}: {
		time: string;
		old: string;
		new: string;
	}) => save({ time, edit: { old, new: replacement } }),
	delete: app.delete,
});

/** A row of `tasks list`: one Result per file, with fitting fields or a Misfit to repair, without notes. */
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
		const { queryKey } = reads.get({ time: file.time });
		const listKey = reads.list().queryKey;
		await Promise.all([
			client.cancelQueries({ queryKey, exact: true }),
			client.cancelQueries({ queryKey: listKey, exact: true }),
		]);
		client.setQueryData(queryKey, file);
		// Collection list rows omit the body.
		const { body: _body, ...row } = file;
		client.setQueryData<ActionOutput<Actions['list']>>(
			listKey,
			(rows) =>
				rows &&
				(rows.some((item) => rowPath(item) === file.path)
					? rows.map((item) => (rowPath(item) === file.path ? Ok(row) : item))
					: [...rows, Ok(row)]),
		);
	},
};

export const writes = {
	...mutations,
	delete: {
		...mutations.delete,
		onSuccess: async (_result, { time }, _previous, { client }) => {
			const { queryKey } = reads.get({ time });
			const listKey = reads.list().queryKey;
			await Promise.all([
				client.cancelQueries({ queryKey, exact: true }),
				client.cancelQueries({ queryKey: listKey, exact: true }),
			]);
			client.setQueryData<ActionOutput<Actions['list']>>(listKey, (rows) =>
				rows?.filter((row) => rowPath(row) !== `data/tasks/${time}.md`),
			);
			client.removeQueries({ queryKey, exact: true });
		},
	} satisfies typeof mutations.delete,
	add: { ...mutations.add, ...saved },
	set: { ...mutations.set, ...saved },
	edit: { ...mutations.edit, ...saved },
};

/** Both readable and malformed rows have a path. */
export const rowPath = (row: ActionOutput<Actions['list']>[number]) =>
	row.error === null ? row.data.path : row.error.path;
