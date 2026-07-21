import {
	createBrowserWorkerHost,
	type MessagePortLike,
} from './browser/worker.js';

type SharedWorkerConnectEvent = {
	ports: MessagePortLike[];
};

type SharedWorkerScope = {
	addEventListener(
		type: 'connect',
		listener: (event: SharedWorkerConnectEvent) => void,
	): void;
};

/** Attach the browser Epicenter host to a SharedWorker global scope. */
export function startBrowserEpicenterWorker(scope: SharedWorkerScope): void {
	const host = createBrowserWorkerHost();
	scope.addEventListener('connect', ({ ports }) => {
		const port = ports[0];
		if (port !== undefined) host.connect(port);
	});
}

const possibleScope = globalThis as Partial<SharedWorkerScope> & {
	onconnect?: unknown;
};
if (
	'onconnect' in possibleScope &&
	typeof possibleScope.addEventListener === 'function'
) {
	startBrowserEpicenterWorker(possibleScope as SharedWorkerScope);
}
