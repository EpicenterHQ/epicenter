import type {
	BunRestoreConstructionRequest,
	BunRestoreWorkerResponse,
} from './bun-restore-v1.js';
import { constructBunAuthorityFromPortableInWorker } from './bun-restore-v1.js';

declare const self: Worker;

self.onmessage = async (event: MessageEvent<BunRestoreConstructionRequest>) => {
	let response: BunRestoreWorkerResponse;
	try {
		response = {
			ok: true,
			result: await constructBunAuthorityFromPortableInWorker(event.data),
		};
	} catch (cause) {
		const error = cause instanceof Error ? cause : new Error(String(cause));
		response = { ok: false, message: error.message, stack: error.stack };
	}
	self.postMessage(response);
};
