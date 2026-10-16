/**
 * The seam import, and the folder and recorder contracts as shared code names
 * them, as the page writes them. `platform-selection.test.ts` bundles this the way each
 * build resolves it to see which leaf and which folder entry it selects.
 */
export { wellFormed } from '@epicenter/folder';
export { recoverRecordings } from '@epicenter/recorder';
export { openWorkspace } from '#platform/workspace';
