/**
 * Messages' one store, as its components read it: this page's drafts and
 * attempts, kept in the browser's files for this origin (OPFS) for good.
 * `Startup.svelte` opens it before the app renders, and `MessagesApp` sets
 * it for every component under it. Messages has only the local variant
 * (ADR-0700): it never signs in, and nothing here uploads, because a draft
 * and its send attempt belong to the Beeper installation on this computer.
 *
 * The context holds the client itself: a draft's send and recovery
 * (`drafts.ts`) write through it, and `fromClient(device)` is the one
 * adapter the views read.
 */
import type { Client } from '@epicenter/definition/contract';
import { createContext } from 'svelte';
import type { Messages } from './contract.js';

export const [getDevice, setDevice] = createContext<Client<Messages>>();
