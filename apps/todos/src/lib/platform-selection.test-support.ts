/**
 * The seam import alone, as the page writes it. `platform-selection.test.ts`
 * bundles this the way each build resolves it to see which leaf it selects.
 */
export { auth } from '#platform/auth';
export { connectEpicenter, httpFetch } from './remote.js';
