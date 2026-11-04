/**
 * PROTOTYPE option (f): no top-level await. The world is one promise, made
 * when this module loads; every component that needs a value awaits it.
 * Retry replaces the promise (a live binding), since a rejected promise
 * stays rejected.
 */
import { openWorld } from '../open.js';

export let world = openWorld('f');

export function reopen() {
	world = openWorld('f');
}
