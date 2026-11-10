import { connect } from '@epicenter/app/client';
import type vocabApp from '../../../epicenter.js';
import type { DueWord, Grade, WordRow } from '../../../epicenter.js';

/** Vocab's actions, asked of the server that serves this UI. */
export const app = connect<typeof vocabApp>('vocab');

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
			let reviewed: Awaited<ReturnType<typeof app.review>>;
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
