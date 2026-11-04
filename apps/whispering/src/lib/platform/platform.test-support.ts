/**
 * The bundle test's entry (`platform.test.ts`): every `#platform/*` seam,
 * and `app.ts`, which makes the capabilities from them.
 */
export { account, ai, folder, recorder, shortcut, speech } from '../app.js';
export { connectAccount } from '#platform/account';
export { Callback, Chrome, Settings } from '#platform/components';
export { localModelServers, microphone, openShortcut } from '#platform/computer';
export { variant } from '#platform/variant';
