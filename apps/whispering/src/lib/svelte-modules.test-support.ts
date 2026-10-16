/**
 * Forwards to the shared runes-module loader for the tests under `workspace/`
 * and `microphone-input.test.ts`, which still import it from here. Other tests
 * import `packages/svelte/src/svelte-modules.test-support.js` directly; delete
 * this file once those last importers do too.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
