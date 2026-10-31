/**
 * Messages' device in Svelte context: this page's drafts and attempts, kept
 * in the browser's files for this origin (OPFS). Messages never signs in, so
 * nothing here uploads: a draft and its send attempt belong to the Beeper
 * installation on this computer.
 */
import type { Client } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';
import type { Messages } from './contract.js';

/** The device's client (for reads straight from storage) and that client as Svelte state. */
export type Device = {
	client: Client<Messages>;
	files: ReactiveClient<Messages>;
};

export const [getDevice, setDevice] = createContext<Device>();
