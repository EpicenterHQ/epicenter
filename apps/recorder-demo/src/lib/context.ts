/**
 * The demo's two sides in context (decision 10): the device at the root,
 * always there; the remote only under the signed-in subtree, one per
 * account. Each is its client, for what the contract's client alone does
 * (bytes, the outbox, the cache, uploading), and that client as Svelte state
 * (`fromClient`), which every view reads and edits through.
 */
import type { Client } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Recorder } from '../contract.ts';

export type Side = {
	client: Client<Recorder>;
	files: ReactiveClient<Recorder>;
};

export const [getDevice, setDevice] = createContext<Side>();
export const [getRemote, setRemote] = createContext<Side>();
