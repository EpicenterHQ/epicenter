/**
 * Home's local transcription model administration.
 *
 * Epicenter has exactly one **active** local transcription model per device.
 * The host owns it; Home is the window that administers it (ADR-0180): which
 * model is active, downloading and deleting model files, and when the host
 * drops the resident model. Applications ask for transcription and never for a
 * model, so this store is the only place in the product where a model is chosen.
 *
 * Three kinds of truth, deliberately kept apart:
 *
 *  - CATALOG, at rest: the models Rust offers, each carrying whether its file is
 *    already in the shared Hugging Face cache. Rust owns it (ADR-0022);
 *    refreshed on first use, on window focus, and after every mutation.
 *  - TRANSFERS, in motion: downloads underway, with progress and a cancel flag.
 *    Transient, fed by the download Channel; never in a catalog scan yet.
 *  - HOST SETTINGS, durable: the active model and the unload policy, owned by
 *    Rust and device-local, read back so this view reflects what the host will
 *    actually do rather than what it last asked for.
 *
 * Nothing here reports residency. Whether a model is loaded, warm, or evicted is
 * host-private; `installed` is disk presence and nothing more.
 *
 * Native-only. Home is also served to a plain browser and to a remote device,
 * where these commands do not exist and the model files are on another machine
 * anyway. Off Tauri the store stays inert and reports `available: false` rather
 * than throwing at import.
 */
import { Channel } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import {
	type ActiveModel,
	commands,
	type DownloadProgress,
	type ModelInfo,
	type UnloadPolicy,
} from './bindings.gen';
import { isDesktopHost } from './runtime.ts';

export type ModelTransferState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number; cancelling: boolean }
	| { type: 'ready' };

function createLocalModels() {
	// `null` until the first scan lands, so "loading" differs from "empty".
	let models = $state.raw<ModelInfo[] | null>(null);
	let active = $state.raw<ActiveModel | null>(null);
	let unloadPolicy = $state.raw<UnloadPolicy>('after_5_minutes');

	// Keyed by model id. The map IS the re-entry gate: a key present means a
	// transfer owns that model, cleared only when that same run settles, so a
	// cancel can never reopen the door for a second overlapping download over the
	// same file. `id` is unique per attempt, so Rust maps it to exactly one
	// transfer; `cancelling` gates late progress.
	const transfers = new SvelteMap<
		string,
		{ id: string; progress: number; cancelling: boolean }
	>();
	let attempts = 0;

	/** The last failure worth showing, cleared by the next successful action. */
	let error = $state.raw<string | null>(null);

	const available = isDesktopHost();

	async function refresh() {
		if (!available) return;
		const [scanned, activeModel, policy] = await Promise.all([
			commands.listModels(),
			commands.getActiveModel(),
			commands.getUnloadPolicy(),
		]);
		models = scanned;
		active = activeModel;
		unloadPolicy = policy;
	}

	/**
	 * Make `model` the one active local model. Every ordinary local
	 * transcription on this device runs on it from the next call onward.
	 */
	async function activate(model: ModelInfo) {
		const result = await commands.setActiveModel(model.id);
		if (result.error !== null) {
			error = result.error.message;
			return;
		}
		error = null;
		await refresh();
	}

	/**
	 * Download a model into the shared HF cache, skipping when it is already
	 * present. Reports whether the model ended up on disk. Never activates:
	 * downloading is acquiring a file, and choosing what runs is a separate act.
	 */
	async function download(model: ModelInfo): Promise<boolean> {
		if (transfers.has(model.id)) return false;
		const id = `${model.id}#${++attempts}`;
		transfers.set(model.id, { id, progress: 0, cancelling: false });

		// Already downloaded? A fresh scan is the one truth; skip the transfer.
		await refresh();
		const alreadyInstalled = (models ?? []).find(
			(m) => m.id === model.id,
		)?.downloaded;
		// A cancel that arrived during the install check stops here.
		if (alreadyInstalled || transfers.get(model.id)?.cancelling) {
			transfers.delete(model.id);
			return Boolean(alreadyInstalled);
		}

		const channel = new Channel<DownloadProgress>();
		channel.onmessage = ({ bytesReceived, totalBytes }) => {
			// f64 fields arrive as `number | null` (specta guards non-finite
			// floats). Guard the total anyway.
			const received = bytesReceived ?? 0;
			const total = totalBytes && totalBytes > 0 ? totalBytes : 0;
			if (total <= 0) return;
			const progress = Math.min(100, Math.round((received / total) * 100));
			const transfer = transfers.get(model.id);
			if (transfer && !transfer.cancelling)
				transfers.set(model.id, { ...transfer, progress });
		};

		const result = await commands.downloadModel(model.id, id, channel);
		const wasCancelled = transfers.get(model.id)?.cancelling ?? false;
		transfers.delete(model.id);
		if (result.error !== null) {
			// A requested cancel is the cause of this error: a clean stop, not a
			// failure worth reporting.
			if (!wasCancelled) error = result.error.message;
			await refresh();
			return false;
		}
		error = null;
		await refresh();
		return true;
	}

	void refresh();

	return {
		/** Whether this device can administer local models at all. */
		get available() {
			return available;
		},
		/** The catalog scan. */
		get models() {
			return models ?? [];
		},
		/** Whether the first scan has landed. */
		get loaded() {
			return models !== null;
		},
		/** The active model, or `null` when nobody has chosen one. */
		get active() {
			return active;
		},
		/** When the host drops the resident model. */
		get unloadPolicy() {
			return unloadPolicy;
		},
		get error() {
			return error;
		},

		/** Where a model stands: a live transfer, else catalog download truth. */
		stateOf(model: ModelInfo): ModelTransferState {
			const transfer = transfers.get(model.id);
			if (transfer)
				return {
					type: 'downloading',
					progress: transfer.progress,
					cancelling: transfer.cancelling,
				};
			return model.downloaded ? { type: 'ready' } : { type: 'not-downloaded' };
		},

		/**
		 * Re-read the catalog and host settings. The shared HF cache can change
		 * outside the app, so views call this on window focus.
		 */
		refresh,

		activate,

		async setUnloadPolicy(policy: UnloadPolicy) {
			const result = await commands.setUnloadPolicy(policy);
			if (result.error !== null) {
				error = result.error.message;
				return;
			}
			error = null;
			await refresh();
		},

		download,

		/**
		 * The first-run path: fetch a model and make it the active one, as a single
		 * labelled act. Two steps by two verbs, not an implicit consequence of
		 * downloading, because adoption is never automatic (ADR-0180) and a second
		 * download must not silently reassign what every app on this machine
		 * transcribes with.
		 */
		async downloadAndActivate(model: ModelInfo) {
			if (await download(model)) await activate(model);
		},

		/**
		 * Request cancellation of an in-flight download. Marks it cancelling (the
		 * UI shows "Cancelling…") and aborts its transfer in Rust. A no-op when
		 * nothing is downloading.
		 */
		async cancel(model: ModelInfo) {
			const transfer = transfers.get(model.id);
			if (!transfer) return;
			transfers.set(model.id, { ...transfer, cancelling: true });
			await commands.cancelDownload(transfer.id);
		},

		/**
		 * Remove a downloaded model's file from the shared HF cache.
		 *
		 * One invoke, not two. Deleting the file and standing down the active
		 * choice are one host operation, so this cannot half-succeed into a state
		 * where the file is gone but the host still points at it. The host clears
		 * rather than promoting another installed model: there is no substitution,
		 * so the next transcription fails with an actionable error until the user
		 * picks again.
		 */
		async remove(model: ModelInfo) {
			const result = await commands.deleteModel(model.id);
			if (result.error !== null) {
				error = result.error.message;
				// The host may have removed the file before failing to clear the
				// choice, so re-read rather than assuming nothing changed.
				await refresh();
				return;
			}
			error = null;
			await refresh();
		},
	};
}

/** The one shared model-administration store. */
export const localModels = createLocalModels();
