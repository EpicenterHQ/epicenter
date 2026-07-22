import {
	type BrowserRecordCandidateWorkerScope,
	startBrowserRecordCandidateWorker,
} from './browser-record/worker.js';

startBrowserRecordCandidateWorker(
	globalThis as unknown as BrowserRecordCandidateWorkerScope,
);
