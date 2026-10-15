/**
 * The seam imports alone, as the page writes them. `platform-selection.test.ts`
 * bundles this the way each build resolves it to see which leaves it selects.
 */
export { auth } from '#platform/auth';
export { openTodosFolder } from '#platform/folder';
export { gitAccess } from './remote.js';
