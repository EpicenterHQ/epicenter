/**
 * This device's Vocab settings, read from the DEVICE document's `kv`.
 *
 * Always the device document, signed in or out (ADR-0233): how this screen
 * renders is a fact about this screen, not portable work, so it does not follow
 * the account replica and does not travel between machines.
 *
 * `kv` rather than a settings row, because a KV root is addressed by its name.
 * A row at a chosen id let two devices each mint a container at that address on
 * their own boot paths, and map LWW then discarded one along with everything in
 * it (ADR-0213).
 */

import type { AppStore } from '@epicenter/app';
import type { vocabDefinition } from '$lib/data';

const APPLICATION_DEFAULTS = { showReadings: true } as const;

export function createSettingsState({
	data,
}: {
	data: AppStore<typeof vocabDefinition>;
}) {
	function read(): boolean {
		// One key, one fallback. `get` answers `undefined` for a key never
		// written and for one this release cannot read, and the recovery is the
		// same for both: the application's own default. This used to be a
		// whole-object `Result` read and a `{ ...APPLICATION_DEFAULTS,
		// ...error.conforming }` merge, in both apps, to arrive here.
		return data.kv.get('showReadings') ?? APPLICATION_DEFAULTS.showReadings;
	}

	let showReadings = $state.raw(read());
	// Registration is synchronous, does no I/O and never fires initially, so the
	// read above has already seen everything (ADR-0187).
	const stop = data.kv.subscribe(() => {
		showReadings = read();
	});

	return {
		/** Whether pronunciation readings render over the tutor's text. */
		get showReadings() {
			return showReadings;
		},
		/** Flip it. A schema failure is reported by the next read, not this write. */
		toggleReadings(): void {
			data.kv.update({ showReadings: !showReadings });
		},
		[Symbol.dispose]: stop,
	};
}
