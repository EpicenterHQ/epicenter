/**
 * The browser's one detector of changes a page did not make (ADR-0548).
 *
 * Pages of one origin that open the same folder share its files. Each page
 * posts the paths of every write that landed, its saves and the incoming
 * steps its Sync applied alike, on a `BroadcastChannel`, and every other page
 * reports what it hears. A page that was frozen or kept in the back-forward
 * cache heard nothing meanwhile, so on resuming it reports everything.
 * Returning to a window is not evidence of a change and reports nothing.
 */
import type { FilesChanged } from './folder.js';
import { callObserver } from './observer.js';
import type { ChangeDetector } from './open-at-root.js';
import type { OpfsEnvironment } from './opfs-store.js';

export function browserChangeDetector(
	environment: Pick<OpfsEnvironment, 'BroadcastChannel' | 'page'>,
	channelName: string,
): ChangeDetector {
	return (report: (change: FilesChanged) => void) => {
		let open = true;
		let channel: BroadcastChannel | undefined;
		const close = () => {
			try {
				channel?.close();
			} catch {
				// A channel that will not close has nothing left to give back.
			}
		};
		if (environment.BroadcastChannel !== undefined) {
			channel = new environment.BroadcastChannel(channelName);
			try {
				// A runtime that counts an open channel as pending work must not
				// be kept alive by a folder nobody closed.
				(channel as { unref?: () => void }).unref?.();
				channel.onmessage = ({ data }) => {
					if (open && Array.isArray(data)) report(data as string[]);
				};
			} catch (cause) {
				// A channel that cannot listen is released before the open fails.
				close();
				throw cause;
			}
		}
		const { window: page, document } = environment.page ?? {};
		const onPageShow = (event: Event) => {
			if (open && (event as PageTransitionEvent).persisted)
				report('everything');
		};
		const onResume = () => {
			if (open) report('everything');
		};
		page?.addEventListener('pageshow', onPageShow);
		document?.addEventListener('resume', onResume);
		return {
			// A relay that fails is another page's missed report, never this
			// write's failure.
			relay(paths) {
				if (open && channel !== undefined && paths.length > 0)
					callObserver(
						'change relay',
						(landed: readonly string[]) => channel?.postMessage([...landed]),
						paths,
					);
			},
			stop() {
				if (!open) return;
				open = false;
				page?.removeEventListener('pageshow', onPageShow);
				document?.removeEventListener('resume', onResume);
				close();
			},
		};
	};
}
