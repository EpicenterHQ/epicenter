import { connect } from '@epicenter/app/client';
import type vocabApp from '../../epicenter.js';
import type { DueWord, Grade, WordRow } from '../../epicenter.js';

/** What `review` returns: the word's new schedule, and when each grade would make it due next. */
type Reviewed = Awaited<ReturnType<typeof vocabApp.actions.review.run>>;

/**
 * The view's copy of what `epicenter serve` last answered: every word, and
 * the words due now. It keeps nothing between page loads; `refresh` asks
 * again, as the layout does when the page comes back into view.
 */
function createVocab() {
	const app = connect('vocab');
	let words = $state.raw<WordRow[]>([]);
	let due = $state.raw<DueWord[]>([]);
	let problem = $state<string>();
	let loaded = $state(false);
	let refreshes = $state(0);

	async function refresh() {
		try {
			const [allWords, dueWords] = await Promise.all([
				app.call<WordRow[]>('words list'),
				app.call<DueWord[]>('due'),
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
		/** Asks for the actions by their words, as `connect` does. */
		call: app.call,
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
			const others = () => due.filter((other) => other.word !== word.word);
			due = others();
			let reviewed: Reviewed;
			try {
				reviewed = await app.call<Reviewed>('review', { word: word.word, grade });
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
