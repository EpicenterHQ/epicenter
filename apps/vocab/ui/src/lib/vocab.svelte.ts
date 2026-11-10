import { type ActionInput, type ActionOutput, connect } from '@epicenter/app/client';
import { resolve } from '$app/paths';
import { toast } from '@epicenter/ui/sonner';
import type vocabApp from '../../../epicenter.js';
import type { Grade } from '../../../epicenter.js';

type Actions = (typeof vocabApp)['actions'];

/**
 * Vocab's actions, asked of the server that serves this UI. A change saved to
 * its file but not recorded in the folder's history says so, with the command
 * that records it.
 */
export const app = connect<typeof vocabApp>('vocab', {
	onUncommitted: ({ sync }) =>
		toast.warning('Saved to the file, but not recorded in history', {
			id: 'uncommitted',
			description: `To record it, run ${sync} on the computer that runs Epicenter.`,
		}),
});

/** A row of `vocab list`: a word's path, the word, and its fields; `problems` when its file does not fit. */
export type WordRow = ActionOutput<Actions['list']>[number];

/** A word as `vocab get` reads it: a row and its body, which holds examples and notes. */
export type Word = ActionOutput<Actions['get']>;

/** A word due now, with when each grade would make it due next. */
export type DueWord = ActionOutput<Actions['due']>[number];

/** The fields `vocab set` takes besides the path. */
export type WordChanges = Omit<ActionInput<Actions['set']>, 'path'>;

/**
 * The page of the word at `path`: the hash route is the path itself,
 * `#/words/你好.md`, each part encoded so any word survives.
 */
export const hrefOf = (path: string) =>
	resolve('/[...path]', { path: path.split('/').map(encodeURIComponent).join('/') });

/**
 * The UI's copy of what `epicenter serve` last answered: every word, and
 * the words due now. It keeps nothing between page loads; `refresh` asks
 * again, as the layout does when the page comes back into view.
 */
function createVocab() {
	let words = $state.raw<WordRow[]>([]);
	let due = $state.raw<DueWord[]>([]);
	let problem = $state<string>();
	let loaded = $state(false);
	let refreshes = $state(0);

	async function refresh() {
		try {
			const [allWords, dueWords] = await Promise.all([
				app.list(),
				app.due(),
			]);
			words = allWords;
			due = dueWords;
			problem = undefined;
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		loaded = true;
		refreshes++;
	}

	return {
		refresh,
		/** Every word, without bodies. */
		words: () => words,
		/** The words due now, in review order, with their bodies. */
		due: () => due,
		/** Why the last refresh failed, until one succeeds. */
		problem: () => problem,
		/** Whether the first refresh has answered, either way. */
		loaded: () => loaded,
		/** How many refreshes have answered: a page that keeps its own copy reloads when it changes. */
		refreshes: () => refreshes,

		/**
		 * Grade a due word. It leaves the queue at once, and `again` puts it back
		 * at the end for this sitting once the review is saved. A failed save
		 * puts it back first.
		 */
		async grade(word: DueWord, grade: Grade) {
			const others = () => due.filter((other) => other.path !== word.path);
			due = others();
			let reviewed: ActionOutput<Actions['review']>;
			try {
				reviewed = await app.review({ path: word.path, grade });
			} catch (error) {
				due = [word, ...others()];
				throw error;
			}
			if (grade === 'again') {
				const { due: when, interval, ease, reps, next } = reviewed;
				due = [...others(), { ...word, due: when, interval, ease, reps, next }];
			}
		},
	};
}

export const vocab = createVocab();
