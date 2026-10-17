/**
 * Showing the section of Settings an app asked the shell to open.
 *
 * `open_home(section)` records the request in the shell before it touches a
 * window, then nudges Settings with `HomeSectionPending`
 * (`src-tauri/src/lib.rs`). Settings claims the request when it mounts and on
 * each nudge. Claiming empties it, so a request shows its section once
 * however many nudges arrive, and one made before Settings opened is shown
 * when it does.
 */
import type { HomeSection } from './bindings.gen';

/**
 * Follow section requests until the returned stop is called. The nudge is
 * heard before the first claim, so a request that lands between them is
 * still claimed.
 */
export function followHomeSections({
	claim,
	onNudge,
	show,
}: {
	/** Take the pending request: `take_pending_home_section`. */
	claim: () => Promise<HomeSection | null>;
	/** Listen for `HomeSectionPending`; resolves to what stops listening. */
	onNudge: (nudged: () => void) => Promise<() => void>;
	show: (section: HomeSection) => void;
}): () => void {
	let stopped = false;
	const take = async () => {
		const section = await claim();
		if (section !== null && !stopped) show(section);
	};
	const listening = onNudge(() => void take());
	void listening.then(take);
	return () => {
		stopped = true;
		void listening.then((stop) => stop());
	};
}
