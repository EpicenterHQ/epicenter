/**
 * PROTOTYPE option (s), standing for `@epicenter/folder`'s `openFolder`:
 * opening is synchronous and readiness is a value. The folder starts opening
 * at once; `state()` says whether it is opening, ready or failed, `subscribe`
 * tells when that changes, and `retry()` opens again after a failure. A
 * ready folder stays ready. Here it wraps the prototype's async opener.
 */
import type { Client, Contract } from '@epicenter/definition/contract';
import { closeWorld, type OpenFailed, openWorld } from '../open.js';

export type FolderState<TClient> =
	| { status: 'opening' }
	| { status: 'ready'; client: TClient }
	| { status: 'failed'; error: OpenFailed };

export type Folder<TClient> = {
	state(): FolderState<TClient>;
	/** The client of a ready folder; throws while it is opening or failed. */
	client(): TClient;
	subscribe(listener: () => void): () => void;
	/** Open again after a failure; does nothing otherwise. */
	retry(): void;
	[Symbol.dispose](): void;
};

export function openFolder<TContract extends Contract>(
	_contract: TContract,
): Folder<Client<TContract>> {
	type C = Client<TContract>;
	let state: FolderState<C> = { status: 'opening' };
	let disposed = false;
	const listeners = new Set<() => void>();
	function set(next: FolderState<C>) {
		state = next;
		for (const listener of listeners) listener();
	}
	function start() {
		set({ status: 'opening' });
		openWorld('s').then(
			(world) => {
				if (disposed) return closeWorld(world);
				set({ status: 'ready', client: world.folder as unknown as C });
			},
			(error: OpenFailed) => {
				if (!disposed) set({ status: 'failed', error });
			},
		);
	}
	start();
	return {
		state: () => state,
		client() {
			if (state.status !== 'ready') throw new Error(`the folder is ${state.status}`);
			return state.client;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		retry() {
			if (state.status === 'failed') start();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			listeners.clear();
			if (state.status === 'ready') closeWorld({ folder: state.client as never });
		},
	};
}
