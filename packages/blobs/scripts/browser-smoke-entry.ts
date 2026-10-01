// Browser journey against the same owners used by the application.

export { createBrowserRecording } from '../../app/src/recording/browser.js';
export { generateBlobId } from '../src/blob-id.js';
export {
	createBrowserBlobSources,
	createBrowserBlobStore,
} from '../src/browser.js';
export { createLocalBlobAccess } from '../src/owner.js';
