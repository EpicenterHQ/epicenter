/**
 * This page's device in Svelte context (decision 10): Vocab's notes in this
 * browser's files (OPFS), set at the root and always there. The signed-in
 * subtree reads it for the outbox and the uploader.
 */
import type { Client } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Vocab } from './contract.js';

export type Device = {
	client: Client<Vocab>;
	files: ReactiveClient<Vocab>;
};

export const [getDevice, setDevice] = createContext<Device>();
