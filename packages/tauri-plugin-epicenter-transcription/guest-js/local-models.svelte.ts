/** Per-mount model administration. Rust owns downloads; the page owns activation intent. */
import { Channel } from '@tauri-apps/api/core';
import { SvelteMap } from 'svelte/reactivity';
import {
	commands as bindings,
	type CatalogError,
	type DownloadProgress,
	type ModelInfo,
	type UnloadPolicy,
} from './bindings.gen.js';

export type LocalModelCommands = Pick<
	typeof bindings,
	| 'listModels'
	| 'getActiveModel'
	| 'getUnloadPolicy'
	| 'setActiveModel'
	| 'setUnloadPolicy'
	| 'downloadModel'
	| 'revealModel'
>;

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

export function createLocalModels(commands: LocalModelCommands = bindings) {
	let models = $state.raw<ModelInfo[] | null>(null);
	let active =
		$state.raw<Awaited<ReturnType<LocalModelCommands['getActiveModel']>>>(null);
	let unloadPolicy = $state.raw<UnloadPolicy>('after_5_minutes');
	let error = $state.raw<string | null>(null);
	let disposed = false;
	let readRevision = 0;
	const transfers = new SvelteMap<string, { progress: number }>();

	async function refresh() {
		if (disposed) return;
		const revision = ++readRevision;
		try {
			const [scanned, activeModel, policy] = await Promise.all([
				commands.listModels(),
				commands.getActiveModel(),
				commands.getUnloadPolicy(),
			]);
			if (!disposed && revision === readRevision) {
				models = scanned;
				active = activeModel;
				unloadPolicy = policy;
			}
			return scanned;
		} catch (cause) {
			if (!disposed && revision === readRevision) error = message(cause);
		}
	}

	async function activate(model: ModelInfo) {
		if (disposed) return;
		try {
			const { error: failure } = await commands.setActiveModel(model.id);
			if (disposed) return;
			error = failure?.message ?? null;
			if (failure === null) await refresh();
		} catch (cause) {
			if (!disposed) error = message(cause);
		}
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
				const channel = new Channel<DownloadProgress>();
				channel.onmessage = ({ bytesReceived, totalBytes }) => {
					if (!alive() || !totalBytes || totalBytes <= 0) return;
					transfer.progress = Math.min(
						100,
						Math.round(((bytesReceived ?? 0) / totalBytes) * 100),
					);
				};
				const result = await commands.downloadModel(model.id, channel);
				if (!alive()) {
					if (result.error === null && !disposed) {
						await refresh();
						if (!alive()) return;
					}
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
			// No await separates the final interest check from activation submission.
			if (useAfterDownload) await activate(model);
		} catch (cause) {
			if (alive()) error = message(cause);
		} finally {
			if (transfers.get(model.id) === transfer) transfers.delete(model.id);
		}
	}

	return {
		get models() {
			return models ?? [];
		},
		get loaded() {
			return models !== null;
		},
		get active() {
			return active;
		},
		get unloadPolicy() {
			return unloadPolicy;
		},
		get error() {
			return error;
		},
		refresh,
		activate,
		download: (model: ModelInfo) => download(model),
		downloadAndActivate: (model: ModelInfo) => download(model, true),
		stop(model: ModelInfo) {
			transfers.delete(model.id);
		},
		stateOf(model: ModelInfo): ModelTransferState {
			const transfer = transfers.get(model.id);
			if (transfer) return { type: 'downloading', progress: transfer.progress };
			if (model.downloaded) return { type: 'ready' };
			return { type: 'not-downloaded' };
		},
		async setUnloadPolicy(policy: UnloadPolicy) {
			if (disposed) return;
			try {
				const { error: failure } = await commands.setUnloadPolicy(policy);
				if (disposed) return;
				error = failure?.message ?? null;
				if (failure === null) await refresh();
			} catch (cause) {
				if (!disposed) error = message(cause);
			}
		},
		async reveal(model: ModelInfo) {
			if (disposed) return;
			try {
				const { error: failure } = await commands.revealModel(model.id);
				if (disposed) return;
				error = failure?.message ?? null;
				if (failure !== null) await refresh();
			} catch (cause) {
				if (!disposed) error = message(cause);
			}
		},
		dispose() {
			disposed = true;
			transfers.clear();
		},
	};
}
