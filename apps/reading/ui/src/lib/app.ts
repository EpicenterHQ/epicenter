/**
 * What Reading's pages watch and what they change, as TanStack options over
 * the actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.get({ path }))` and writes with
 * `createMutation(() => writes.set)`; the layout's QueryClient refreshes
 * every read after each write.
 */
import { type ActionOutput, connect } from '@epicenter/app/client';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type readingApp from '../../../epicenter.js';

type Actions = (typeof readingApp)['actions'];

const app = connect<typeof readingApp>('reading');

export const reads = resultQueries(['reading'], { list: app.list, get: app.get });

export const writes = resultMutations(['reading'], {
	add: app.add,
	set: app.set,
	edit: app.edit,
	start: app.start,
	finish: app.finish,
	delete: app.delete,
});

/** A row of `reading list`: a book's path and fields, without its notes; `problems` when its file does not fit. */
export type Book = ActionOutput<Actions['list']>[number];
