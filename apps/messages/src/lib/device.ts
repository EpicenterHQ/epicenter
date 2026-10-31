/**
 * Messages' one store, as its components read it: this page's drafts and
 * attempts, kept in the browser's files for this origin (OPFS) for good.
 * `Startup.svelte` opens it before the app renders, and `MessagesApp` sets
 * it for every component under it. Messages has only the local variant
 * (ADR-0700): it never signs in, and nothing here uploads, because a draft
 * and its send attempt belong to the Beeper installation on this computer.
 *
 * The context holds the client and its Svelte state together (`Device`),
 * wrapped once where `MessagesApp` sets it (decision 87): a draft's send and
 * recovery (`drafts.ts`) read straight from storage through the client, and
 * the views read and write through `files`.
 */
import { createContext } from 'svelte';
import type { Device } from './drafts.js';

export const [getDevice, setDevice] = createContext<Device>();
