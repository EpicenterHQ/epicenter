/**
 * The demo's two clients in context (decision 10): the device at the root,
 * always there; the remote only under the signed-in subtree, one per
 * account.
 */
import type { Client } from '@epicenter/definition/contract';
import { createContext } from 'svelte';
import type { Recorder } from '../contract.ts';

export const [getDevice, setDevice] = createContext<Client<Recorder>>();
export const [getRemote, setRemote] = createContext<Client<Recorder>>();
