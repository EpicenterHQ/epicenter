/**
 * What Capture's pages watch and what they change, as TanStack options over
 * the actions `epicenter serve` runs (ADR-0661). A page reads with
 * `createQuery(() => reads.get({ path }))` and writes with
 * `createMutation(() => writes.add)`; the layout's QueryClient refreshes
 * every read after each write.
 */
import { type ActionOutput, connect } from '@epicenter/app/client';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import type capture from '../../../epicenter.js';

type Actions = (typeof capture)['actions'];

const app = connect<typeof capture>('capture');

export const reads = resultQueries(['capture'], { recent: app.recent, get: app.get });

export const writes = resultMutations(['capture'], {
	add: app.add,
	edit: app.edit,
	delete: app.delete,
});

/** A capture file as `get` and `edit` return it. */
export type CaptureFile = ActionOutput<Actions['get']>;

/** One capture as listed; `pending` while its `add` has not answered. */
export type Row = ActionOutput<Actions['recent']>['captures'][number] & {
	pending?: true;
};

/**
 * The page of the capture at `path`: the hash route is the path itself,
 * `#/data/captures/<time>.md`, each part encoded so any file name survives.
 */
export const hrefOf = (path: string) =>
	`#/${path.split('/').map(encodeURIComponent).join('/')}`;
