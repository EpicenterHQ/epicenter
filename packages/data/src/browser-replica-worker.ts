import {
	type BrowserReplicaOwnerWorkerScope,
	startBrowserReplicaOwnerWorker,
} from './store/replica/browser-owner-worker.js';

startBrowserReplicaOwnerWorker(
	globalThis as unknown as BrowserReplicaOwnerWorkerScope,
);
