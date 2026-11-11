/**
 * What Vocab's pages watch and what they change, as TanStack options over the
 * actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.due())` and writes with
 * `createMutation(() => writes.review)`; the layout's QueryClient refreshes
 * every read after each write.
 */
import { type ActionInput, type ActionOutput, connect } from '@epicenter/app/client';
import { resolve } from '$app/paths';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type vocabApp from '../../../epicenter.js';

type Actions = (typeof vocabApp)['actions'];

const app = connect<typeof vocabApp>();

export const reads = resultQueries(['vocab'], { list: app.list, due: app.due, get: app.get });

export const writes = resultMutations(['vocab'], {
	add: app.add,
	set: app.set,
	edit: app.edit,
	delete: app.delete,
	review: app.review,
});

/** A word as `vocab get` reads it: its path, the word, its fields, and its body, which holds examples and notes. */
export type Word = ActionOutput<Actions['get']>;

/** A word due now, with when each grade would make it due next. */
export type DueWord = ActionOutput<Actions['due']>[number];

/** The fields `vocab set` takes besides the path. */
export type WordChanges = Omit<ActionInput<Actions['set']>, 'path'>;

/**
 * The page of the word at `path`: the hash route is the path itself,
 * `#/data/words/你好.md`, each part encoded so any word survives.
 */
export const hrefOf = (path: string) =>
	resolve('/[...path]', { path: path.split('/').map(encodeURIComponent).join('/') });
