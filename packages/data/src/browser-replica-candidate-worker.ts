import {
	type BrowserReplicaCandidateWorkerScope,
	startBrowserReplicaCandidateWorker,
} from './store/replica/browser-candidate-worker.js';

startBrowserReplicaCandidateWorker(
	globalThis as unknown as BrowserReplicaCandidateWorkerScope,
);
