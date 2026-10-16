/**
 * The seam import, and the folder contract as shared code names it, as the
 * page writes them. `platform-selection.test.ts` bundles this the way each
 * build resolves it to see which leaf and which folder entry it selects.
 */
export { wellFormed } from '@epicenter/folder';
export { openWorkspace } from '#platform/workspace';
