/**
 * The bundle test's entry (`platform.test.ts`): every `#platform/*` seam,
 * and the state the pages build over the store.
 */
export { auth } from '#platform/auth';
export { openConnections } from '#platform/connections';
export { Callback, Chrome, Startup, store } from '#platform/root';
export { createVocab } from './vocab.svelte.js';
