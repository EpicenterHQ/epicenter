/**
 * The store of Whispering's web build, which is its local variant: this
 * origin's private files (OPFS, `@epicenter/folder/browser`), at the same
 * paths a desktop folder holds, opened once for the page and only by the
 * variant's root (`routes/(local)/+layout.svelte`). Recordings stay here for
 * good: they never sync and never upload, and signing in moves nothing
 * (ADR-0700).
 *
 * Whispering's desktop app is built separately later, with its own store.
 */
import { closeDevice, openDevice } from '@epicenter/folder/browser';
import { whispering } from './contract.js';

/** This page's device client. */
export const device = openDevice(whispering);

if (import.meta.hot) import.meta.hot.dispose(() => closeDevice(device));
