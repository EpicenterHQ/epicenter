/**
 * The seam import, and the folder and recorder contracts as shared code names
 * them, as the page writes them. `platform-selection.test.ts` bundles this the way each
 * build resolves it to see which leaf and which folder entry it selects.
 */
export { OpenFolderError, openFolder } from '@epicenter/folder';
export { RecorderError } from '@epicenter/recorder';
export { getAuth } from '#platform/auth';
export { createServices } from '#platform/services';
