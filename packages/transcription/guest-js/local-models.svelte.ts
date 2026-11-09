/**
 * Per-mount model administration over a `localSpeech()` handle: the catalog
 * with each model's download state, downloads with progress, removal, and
 * the unload policy. Rust owns downloads; the handle reaches them. Which
 * model the app uses is its own choice (`LocalModelChoice`), never state of
 * this page's: Whispering's is its transcription model choice; an app whose
 * shell transcribes by itself keeps the shell's active model
 * (`createNativeChoice`).
 */
import { SvelteMap } from 'svelte/reactivity';
import type {
	commands as bindings,
	CatalogError,
	ModelInfo,
	UnloadPolicy,
} from './bindings.gen.js';
import type { LocalSpeech } from './local-speech.js';

type ActiveModelCommands = Pick<
	typeof bindings,
	'getActiveModel' | 'setActiveModel'
>;

/** The shell's active model commands, the plugin's bindings loaded with the first call. */
const plugin = () =>
	import('./bindings.gen.js').then((module) => module.commands);
const activeModel: ActiveModelCommands = {
	getActiveModel: async () => (await plugin()).getActiveModel(),
	setActiveModel: async (modelId) => (await plugin()).setActiveModel(modelId),
};

/** What administration does through the handle. */
export type LocalModelHandle = Pick<
	LocalSpeech,
	| 'catalog'
	| 'download'
	| 'remove'
	| 'reveal'
	| 'unloadPolicy'
	| 'setUnloadPolicy'
>;

/**
 * Which local model the app uses: the id chosen now (read where it tracks),
 * and the way to choose another, which answers why it could not.
 */
export type LocalModelChoice = {
	chosen(): string | null;
	choose(modelId: string): Promise<string | undefined>;
};

export type ModelTransferState =
	| { type: 'not-downloaded' }
	| { type: 'downloading'; progress: number }
	| { type: 'ready' };

function downloadFailure(error: CatalogError): string {
	switch (error.name) {
		case 'Busy':
			return 'This model is already downloading. It will show as downloaded when it finishes.';
		case 'DownloadingElsewhere':
			return 'Another app on this computer is downloading this model.';
		default:
			return error.message;
	}
}

const message = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * The model the app's shell transcribes with by itself (its active model,
 * kept in the shell's settings), as a choice: for an app with no model
 * choices of its own, such as the Epicenter app's dictation.
 */
export function createNativeChoice(
	commands: ActiveModelCommands = activeModel,
): LocalModelChoice {
	let chosen = $state.raw<string | null>(null);
	const read = async () => {
		chosen = (await commands.getActiveModel())?.id ?? null;
	};
	void read().catch(() => {});
	return {
		chosen: () => chosen,
		async choose(modelId) {
			try {
				const { error } = await commands.setActiveModel(modelId);
				if (error !== null) return error.message;
				await read();
				return undefined;
			} catch (cause) {
				return message(cause);
			}
		},
	};
}

export function createLocalModels({
	speech,
	choice,
}: {
	speech: LocalModelHandle;
	choice: LocalModelChoice;
}) {
	let models = $state.raw<ModelInfo[] | null>(null);
	let unloadPolicy = $state.raw<UnloadPolicy>('after_5_minutes');
	let error = $state.raw<string | null>(null);
	let disposed = false;
	let readRevision = 0;
	const transfers = new SvelteMap<string, { progress: number }>();

	async function refresh() {
		if (disposed) return;
		const revision = ++readRevision;
		try {
			const [scanned, policy] = await Promise.all([
				speech.catalog(),
				speech.unloadPolicy(),
			]);
			if (!disposed && revision === readRevision) {
				models = scanned;
				unloadPolicy = policy;
			}
			return scanned;
		} catch (cause) {
			if (!disposed && revision === readRevision) error = message(cause);
		}
	}

	async function use(model: ModelInfo) {
		if (disposed) return;
		const problem = await choice.choose(model.id);
		if (!disposed) error = problem ?? null;
	}

	async function download(model: ModelInfo, useAfterDownload = false) {
		if (disposed || transfers.has(model.id)) return;
		const transfer = $state({ progress: 0 });
		transfers.set(model.id, transfer);
		const alive = () => !disposed && transfers.get(model.id) === transfer;
		try {
			const scanned = await refresh();
			if (!alive() || scanned === undefined) return;
			let installed = scanned.some(
				(candidate) => candidate.id === model.id && candidate.downloaded,
			);
			if (!installed) {
				const result = await speech.download(model.id, {
					onProgress({ bytesReceived, totalBytes }) {
						if (!alive() || !totalBytes || totalBytes <= 0) return;
						transfer.progress = Math.min(
							100,
							Math.round(((bytesReceived ?? 0) / totalBytes) * 100),
						);
					},
				});
				if (!alive()) {
					if (result.error === null && !disposed) await refresh();
					return;
				}
				if (result.error !== null) {
					error = downloadFailure(result.error);
					return;
				}
				const downloaded = await refresh();
				if (!alive()) return;
				installed =
					downloaded?.some(
						(candidate) => candidate.id === model.id && candidate.downloaded,
					) ?? false;
			}
			if (!alive() || !installed) return;
			error = null;
			// No await separates the final interest check from the choice.
			if (useAfterDownload) await use(model);
		} catch (cause) {
			if (alive()) error = message(cause);
		} finally {
			if (transfers.get(model.id) === transfer) transfers.delete(model.id);
		}
	}

	/** Run a native action that answers a Result, then read the catalog again. */
	async function act(
		run: () => Promise<{ error: { message: string } | null }>,
	) {
		if (disposed) return;
		try {
			const { error: failure } = await run();
			if (disposed) return;
			error = failure?.message ?? null;
			await refresh();
		} catch (cause) {
			if (!disposed) error = message(cause);
		}
	}

	return {
		get models() {
			return models ?? [];
		},
		get loaded() {
			return models !== null;
		},
		/** The model the app uses now, from its own choice; null when it uses none of these. */
		get chosen() {
			const id = choice.chosen();
			return id === null
				? null
				: (models?.find((model) => model.id === id) ?? null);
		},
		/** The id the app chose, even when it is not in the catalog or not downloaded. */
		get chosenId() {
			return choice.chosen();
		},
		get unloadPolicy() {
			return unloadPolicy;
		},
		get error() {
			return error;
		},
		refresh,
		use,
		download: (model: ModelInfo) => download(model),
		downloadAndUse: (model: ModelInfo) => download(model, true),
		/**
		 * Delete the model's file from the shared Hugging Face cache, which
		 * other apps and tools may use; one that used it downloads it again.
		 */
		remove: (model: ModelInfo) => act(() => speech.remove(model.id)),
		reveal: (model: ModelInfo) => act(() => speech.reveal(model.id)),
		stop(model: ModelInfo) {
			transfers.delete(model.id);
		},
		stateOf(model: ModelInfo): ModelTransferState {
			const transfer = transfers.get(model.id);
			if (transfer) return { type: 'downloading', progress: transfer.progress };
			if (model.downloaded) return { type: 'ready' };
			return { type: 'not-downloaded' };
		},
		setUnloadPolicy: (policy: UnloadPolicy) =>
			act(() => speech.setUnloadPolicy(policy)),
		dispose() {
			disposed = true;
			transfers.clear();
		},
	};
}
