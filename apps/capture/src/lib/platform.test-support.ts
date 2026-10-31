/**
 * The bundle test's entry (`platform.test.ts`): every `#platform/*` seam
 * that resolves outside SvelteKit. `#platform/offline` is left out: its
 * browser leaf imports `$app/*`, which only SvelteKit's plugin provides.
 */
export { webAuth } from '#platform/auth';
export { device } from '#platform/device';
export { folder } from '#platform/folder';
