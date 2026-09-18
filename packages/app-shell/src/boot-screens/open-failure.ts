/**
 * What a person reads when an application cannot open their data, and the one
 * thing they can do about it.
 *
 * `@epicenter/data` states a failure for whoever is debugging one: a refused
 * claim names the storage address it was refused at. That sentence is correct
 * and it is not what someone who opened a notes app should be handed. The
 * library keeps its words; this picks theirs (ADR-0244).
 *
 * **The sentence, the repair, and the library's message are one decision, made
 * here.** They were drifting apart when they were three: a screen that re-read
 * the error to pick its button could offer a retry under a sentence that just
 * said retrying cannot help, and a screen that printed the cause under every
 * sentence printed a storage address under two that already said everything a
 * person can act on. So `detail` is returned rather than derived: it is set on
 * the fallback arm, where the sentence admits it is guessing and the library's
 * own words keep a bug report useful and a wrong guess visible, and it is
 * absent everywhere else. The screen renders what it is handed and decides
 * nothing.
 *
 * **A failure earns a sentence only by changing what a person can DO.** That is
 * two of them, and everything else shares the fallback: `AlreadyOpen`, because
 * they can close the other window, and `LocksUnsupported`, because a retry
 * button there would be a lie. A new arm earns itself when a new failure turns
 * out to reach a person, not before.
 *
 * **One copy, taking the application's nouns.** Three applications rendered
 * these three sentences, byte-identical apart from the word for a person's
 * stuff. The word is the application's and the sentence around it is not, so
 * the word is what crosses this boundary.
 */

import type { StoreError } from '@epicenter/data/browser';
import { extractErrorMessage } from 'wellcrafted/error';

export type OpenFailure = {
	/** What a person reads, in this application's noun. */
	message: string;
	/**
	 * What the screen offers below the sentence.
	 *
	 * `'retry'` opens again, because something outside this device has to change
	 * first. `'none'` offers nothing, and saying so is the point: a button that
	 * cannot help is worse than no button.
	 */
	repair: 'retry' | 'none';
	/**
	 * The library's own message, printed under a sentence that is a guess.
	 *
	 * Absent under the two named sentences, whose library messages name the
	 * storage address, which carries the principal id and helps nobody reading a
	 * boot screen.
	 */
	detail?: string;
};

/**
 * The failures that have a sentence of their own, keyed by the `name` the store
 * refuses with.
 *
 * `Partial<Record<StoreError['name'], …>>` is the whole of the compile-time
 * check: a misspelt arm is a build failure rather than a screen nobody reaches,
 * and the import is type-only, so nothing of `@epicenter/data` ships here.
 */
const SENTENCES = {
	AlreadyOpen: ({ appName, noun }) => ({
		// A confirmed ownership conflict and nothing else. The store used to
		// answer this name for a missing Web Locks API and for a lock request that
		// threw, so this sentence told most of the people who reached it to close
		// a window they did not have open (ADR-0344).
		message: `Another ${appName} window already has your ${noun} open. Close it, then try again.`,
		repair: 'retry',
	}),
	LocksUnsupported: ({ noun }) => ({
		// Not a conflict, and not a retry: this browser ships no Web Locks, so
		// nothing here can prove one window owns the data, and opening unguarded
		// is the silent data loss the guard exists to prevent.
		message: `This browser is too old to open your ${noun} safely. Update it, or use a different one.`,
		repair: 'none',
	}),
} satisfies Partial<
	Record<
		StoreError['name'],
		(nouns: { appName: string; noun: string }) => OpenFailure
	>
>;

/**
 * The sentence a person reads for a failed open, the repair it offers, and the
 * cause to print under it.
 *
 * `error` is `unknown` because this reads nothing off it but `name`, and
 * because the screen that calls it takes whatever the session hands over. An
 * unrecognized failure gets the fallback, which admits it does not know rather
 * than inventing a reason.
 *
 * The nouns are two strings rather than one object with a name, because they
 * are two strings: `appName` is the window a person is told to close, and
 * `noun` is what this application calls their stuff, plural.
 */
export function openFailure(
	error: unknown,
	{ appName, noun }: { appName: string; noun: string },
): OpenFailure {
	if (typeof error === 'object' && error !== null && 'name' in error) {
		const { name } = error;
		if (typeof name === 'string' && Object.hasOwn(SENTENCES, name)) {
			return SENTENCES[name as keyof typeof SENTENCES]({ appName, noun });
		}
	}
	return {
		message: `Your ${noun} could not be opened. Check your connection and try again.`,
		repair: 'retry',
		detail: extractErrorMessage(error),
	};
}
