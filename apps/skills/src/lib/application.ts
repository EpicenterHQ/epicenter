/**
 * One page lifetime's Skills runtime: the opened document and the state bound
 * to it. The root owns it, provides it through context, and disposes it.
 *
 * **This build cannot open one.** Skills was device-only, and the device store
 * is gone: an authority mints every generation, so a store needs an account and
 * this build has no auth client. Skills is one of the applications AGENTS.md
 * lists as broken on purpose until it is rebuilt against the store, and this is
 * the seam where that rebuild starts: give it auth, and the account it already
 * takes below is the only thing it is missing.
 */

import type { ReplicaData } from '@epicenter/app/store';
import {
	type DatabaseAccount,
	openDatabase,
	resolveGeneration,
} from '@epicenter/app/store/browser';
import { skillsDefinition } from '@epicenter/skills';
import { createSkillsState } from './state/skills-state.svelte.js';

/** The application this opens its store as, self-claimed (ADR-0324, ADR-0334). */
const APP_ID = 'so.epicenter.skills';

export type SkillsRuntime = {
	/** This account's replica, open for the whole page lifetime. */
	readonly data: ReplicaData<typeof skillsDefinition>;
	readonly state: ReturnType<typeof createSkillsState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/**
 * Open one Skills generation, hydrated and ready to read synchronously.
 *
 * The only asynchronous thing in this application. Opening a store is real
 * I/O: an IndexedDB checkpoint, a WASM compile, and the replay of a durable
 * log. Everything after it is a property access on a document already in
 * memory, which is why nothing below this line returns a promise.
 */
export async function openSkillsRuntime({
	account,
	signal,
}: {
	account: DatabaseAccount;
	signal?: AbortSignal;
}): Promise<SkillsRuntime> {
	signal?.throwIfAborted();
	const opened = await openDatabase(skillsDefinition, {
		appId: APP_ID,
		generation: await resolveSkillsGeneration(account),
		account,
	});
	if (opened.error !== null) throw opened.error;
	// The store and the thing that ends it, separately (ADR-0340).
	const { store: data, close } = opened.data;

	try {
		signal?.throwIfAborted();
		const state = createSkillsState({ data });
		let disposed = false;
		return Object.freeze({
			data,
			state,
			async [Symbol.asyncDispose]() {
				if (disposed) return;
				disposed = true;
				state[Symbol.dispose]();
				await close();
			},
		});
	} catch (cause) {
		await close().catch(() => undefined);
		throw cause;
	}
}

/**
 * The generation this device opens, minting one when the account holds none.
 *
 * A generation is an address (ADR-0292) and importing is the only way one comes
 * into being (ADR-0293), so "a new database here" is an import of an empty
 * folder, minted by the account's authority.
 */
async function resolveSkillsGeneration(
	account: DatabaseAccount,
): Promise<number> {
	const resolved = await resolveGeneration(skillsDefinition, {
		appId: APP_ID,
		account,
	});
	if (resolved.error !== null) throw resolved.error;
	return resolved.data.generation;
}
