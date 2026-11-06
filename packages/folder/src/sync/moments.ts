/**
 * `syncAtMoments({ folder, remote })`: an open app's sync of its folder, at
 * the moments a person expects (ADR-0750, ADR-0804):
 *
 * | Moment | What runs |
 * | --- | --- |
 * | it starts (the app opening) | a sync |
 * | a burst of the folder's own saves | a sync, `afterSaveMs` after the last |
 * | the window shown or focused again | a sync |
 * | every `checkEveryMs` while the window is shown | a sync, when the repository moved or the folder holds a change the manifest does not |
 * | `now()` (Sync pressed) | a sync |
 *
 * One sync runs at a time: every moment that comes while one runs makes a
 * single sync after it. The periodic check asks the repository only where
 * it is, so an idle open app costs one small request per period; it pauses
 * while the window is hidden. A sync's own writes into the folder are not
 * saves. With no remote (no signed-in account) nothing runs. It stops when
 * disposed or when the folder closes, and nothing runs while the app is
 * closed.
 *
 * The window is a signal the app passes, so the package touches no DOM:
 *
 * ```ts
 * const moments = syncAtMoments({
 *   folder,
 *   remote: repositoryStore(account, '~/todos'),
 *   window: {
 *     shown: () => document.visibilityState === 'visible',
 *     subscribe(changed) {
 *       document.addEventListener('visibilitychange', changed);
 *       window.addEventListener('focus', changed);
 *       return () => {
 *         document.removeEventListener('visibilitychange', changed);
 *         window.removeEventListener('focus', changed);
 *       };
 *     },
 *   },
 * });
 * ```
 */
import { isHiddenPath } from '@epicenter/definition/contract';
import type { Result } from 'wellcrafted/result';
import type { Unavailable } from '../device/store.js';
import { type FolderLifecycle, hearSaves, localStoreOf } from '../folder.js';
import type { Repository } from './repository.js';
import {
	type Manifest,
	type ManifestStore,
	type SyncReport,
	storeManifest,
	sync,
} from './sync.js';

/** What one sync answered. */
export type SyncResult = Result<SyncReport, Unavailable>;

/** The app's window as the moments need it, which the app reads from the DOM or its shell. */
export type WindowShown = {
	/** Whether the window is shown now. */
	shown(): boolean;
	/** Call `changed` when the window is shown, hidden, or focused; returns the unsubscribe. */
	subscribe(changed: () => void): () => void;
};

/** How long after the last save of a burst the folder syncs. */
const AFTER_SAVE_MS = 3000;
/** How often an open, shown window asks whether to sync: as often as the web's repository store polls. */
const CHECK_EVERY_MS = 3000;

/**
 * Sync `folder` (an open folder, or `reactive`'s copy) with `remote` at the
 * moments above, keeping its manifest at `.epicenter/synced.json` unless
 * `manifest` says where. `synced` hears each sync's result.
 */
export function syncAtMoments({
	folder,
	remote,
	manifest,
	window: view,
	afterSaveMs = AFTER_SAVE_MS,
	checkEveryMs = CHECK_EVERY_MS,
	synced,
}: {
	folder: FolderLifecycle;
	remote: Repository | null;
	manifest?: ManifestStore;
	window?: WindowShown;
	afterSaveMs?: number;
	checkEveryMs?: number;
	synced?: (result: SyncResult) => void;
}) {
	const local = localStoreOf(folder);
	const kept = manifest ?? storeManifest(local);
	let stopped = remote === null;
	let running: Promise<SyncResult | null> | null = null;
	let queued: Promise<SyncResult | null> | null = null;
	/** The manifest the last sync left, which the periodic check compares with. */
	let agreed: Manifest | null = null;
	/** Paths the repository refused last time: a change there is no reason to sync again. */
	let refused = new Set<string>();
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let checkTimer: ReturnType<typeof setTimeout> | undefined;

	async function once(): Promise<SyncResult | null> {
		if (stopped || remote === null) return null;
		const result = await sync({ local, remote, manifest: kept });
		if (result.error === null)
			refused = new Set(result.data.refused.map(({ path }) => path));
		const read = await kept.read();
		agreed = read.error === null ? read.data.manifest : null;
		if (!stopped) synced?.(result);
		return result;
	}

	/** Sync now, or once after the sync running now. */
	function request(): Promise<SyncResult | null> {
		if (stopped) return Promise.resolve(null);
		if (running === null) {
			const done = () => {
				running = null;
			};
			running = once().finally(done);
			return running;
		}
		if (queued === null) {
			const next = () => {
				queued = null;
				return request();
			};
			queued = running.then(next, next);
		}
		return queued;
	}

	/** Whether the repository moved since the last sync, or the folder holds a change it did not agree. */
	async function changed(): Promise<boolean> {
		if (remote === null) return false;
		if (agreed === null) return true;
		const since = await remote.changes(agreed.commit);
		// Out of reach: the next check asks again.
		if (since.error !== null) return false;
		if (since.data.commit !== agreed.commit) return true;
		if (Object.keys(agreed.at ?? {}).length > 0) return true;
		// A burst of saves is synced after its last, not in its middle.
		if (saveTimer !== undefined) return false;
		const listed = await local.list(['']);
		if (listed.error !== null) return false;
		const present = new Set<string>();
		for (const { path, version } of listed.data) {
			if (isHiddenPath(path) || refused.has(path)) continue;
			present.add(path);
			if (agreed.files[path] !== version) return true;
		}
		return Object.keys(agreed.files).some((path) => !present.has(path));
	}

	/** Check again in `checkEveryMs`, while the window is shown. */
	function schedule() {
		clearTimeout(checkTimer);
		if (stopped || (view !== undefined && !view.shown())) return;
		checkTimer = setTimeout(async () => {
			if (running === null && (await changed())) await request();
			schedule();
		}, checkEveryMs);
	}

	const unhearSaves = hearSaves(folder, () => {
		if (stopped) return;
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			saveTimer = undefined;
			void request();
		}, afterSaveMs);
	});
	const unwatchWindow = view?.subscribe(() => {
		if (stopped) return;
		if (!view.shown()) {
			clearTimeout(checkTimer);
			return;
		}
		void request();
		schedule();
	});
	const unwatchFolder = folder.subscribe(() => {
		if (folder.state().status === 'closed') stop();
	});

	function stop() {
		stopped = true;
		clearTimeout(saveTimer);
		clearTimeout(checkTimer);
		unhearSaves();
		unwatchWindow?.();
		unwatchFolder();
	}

	if (!stopped) {
		void request();
		schedule();
	} else stop();

	return {
		/**
		 * Sync now (Sync pressed), or once the sync running now ends: that
		 * sync's result, or null when there is no remote or the moments
		 * stopped.
		 */
		now: request,
		/** Stop: no moment syncs after this; a sync running now finishes. */
		[Symbol.dispose]: stop,
	};
}

export type SyncMoments = ReturnType<typeof syncAtMoments>;
