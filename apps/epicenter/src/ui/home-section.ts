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
import { createLogger } from 'wellcrafted/logger';
import type { HomeSection } from './bindings.gen';

const log = createLogger('epicenter/settings');

/**
 * Follow section requests until the returned stop is called. The first claim
 * waits until the nudge is heard, so a request that lands between them is
 * still claimed; if listening fails, the first claim runs anyway. Nothing is
 * claimed after stop, so a request made while the page closes stays for the
 * next Settings.
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
		if (stopped) return;
		let section: HomeSection | null;
		try {
			section = await claim();
		} catch (cause) {
			log.error(
				new Error('Settings could not claim the section an app asked for.', {
					cause,
				}),
			);
			return;
		}
		if (section !== null && !stopped) show(section);
	};
	const listening = onNudge(() => void take());
	void listening.then(take, (cause) => {
		log.error(
			new Error('Settings could not listen for section requests.', { cause }),
		);
		return take();
	});
	return () => {
		stopped = true;
		void listening.then(
			(stopListening) => stopListening(),
			() => undefined,
		);
	};
}

/** What `keepInView` needs from the page; the browser's own by default. */
export type ViewEnvironment = {
	readonly frame: (callback: () => void) => number;
	readonly cancelFrame: (id: number) => void;
	readonly now: () => number;
	/** Listen for the person's own scrolling or input; returns what stops it. */
	readonly onInput: (handler: () => void) => () => void;
};

const INPUTS = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

const browserEnvironment = (): ViewEnvironment => ({
	frame: (callback) => requestAnimationFrame(callback),
	cancelFrame: (id) => cancelAnimationFrame(id),
	now: () => performance.now(),
	onInput(handler) {
		for (const name of INPUTS)
			window.addEventListener(name, handler, { capture: true });
		return () => {
			for (const name of INPUTS)
				window.removeEventListener(name, handler, { capture: true });
		};
	},
});

/**
 * Scroll `target` to the top of the view, and again whenever content above
 * it loads and moves it, until the person scrolls or types, or `settleMs`
 * passes. Settings fills in above the section after it opens, and not every
 * WebView keeps a scrolled-to element in place when that happens.
 */
export function keepInView(
	target: Pick<Element, 'getBoundingClientRect' | 'scrollIntoView'>,
	{
		settleMs = 1500,
		environment = browserEnvironment(),
	}: { settleMs?: number; environment?: ViewEnvironment } = {},
): () => void {
	const scroll = () => {
		target.scrollIntoView({ block: 'start' });
		return target.getBoundingClientRect().top;
	};
	let top = scroll();
	const until = environment.now() + settleMs;
	let frame: number | undefined;
	const stopInput = environment.onInput(() => stop());
	function stop() {
		if (frame !== undefined) environment.cancelFrame(frame);
		frame = undefined;
		stopInput();
	}
	const check = () => {
		frame = undefined;
		if (environment.now() >= until) return stop();
		if (target.getBoundingClientRect().top !== top) top = scroll();
		frame = environment.frame(check);
	};
	frame = environment.frame(check);
	return stop;
}
