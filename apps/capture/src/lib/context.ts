/**
 * Capture's state in Svelte context (decision 10). The device is set at the
 * root and is always there; the signed-in subtree reads it to upload from
 * it. The views read and write captures only through the store they are
 * given (`createCaptures`), never a client.
 */
import type { Capture } from '@epicenter/capture';
import type { Client } from '@epicenter/definition/contract';
import type { ReactiveClient } from '@epicenter/svelte/client';
import { createContext } from 'svelte';

/** This browser's files: the client (for the outbox and uploading) and that client as Svelte state. */
export type Device = {
	client: Client<Capture>;
	files: ReactiveClient<Capture>;
};

export const [getDevice, setDevice] = createContext<Device>();
