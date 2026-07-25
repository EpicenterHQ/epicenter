import {
	type BrowserReplicaStoreWorkerScope,
	startBrowserReplicaStoreWorker,
} from './store/replica/browser-store-worker.js';

startBrowserReplicaStoreWorker(
	globalThis as unknown as BrowserReplicaStoreWorkerScope,
);
