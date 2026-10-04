import type {
	CompleteEvidenceDriver,
	CompleteEngineResult,
	CompleteProfile,
	CompleteWorkerMessage,
} from './replica-layout-complete-contract.js';

declare global {
	interface Window {
		browserCompleteReplicaLayoutEvidence: CompleteEvidenceDriver;
	}
}

function run(
	profile: CompleteProfile,
	runId: string,
): Promise<CompleteEngineResult> {
	const worker = new Worker(
		new URL('./replica-layout-complete-worker.ts', import.meta.url),
		{ type: 'module', name: `epicenter-complete-layout-${runId}` },
	);
	return new Promise((resolve, reject) => {
		worker.addEventListener(
			'message',
			({ data }: MessageEvent<CompleteWorkerMessage>) => {
				switch (data.type) {
					case 'progress':
						console.log(data.message);
						return;
					case 'result':
						worker.terminate();
						resolve(data.result);
						return;
					case 'error': {
						worker.terminate();
						const error = new Error(data.message);
						error.name = data.name;
						if (data.stack !== undefined) error.stack = data.stack;
						reject(error);
					}
				}
			},
		);
		worker.addEventListener('error', ({ message }) => {
			worker.terminate();
			reject(new Error(message || 'Browser COMPLETE layout worker failed'));
		});
		worker.postMessage({ type: 'run', profile, runId });
	});
}

window.browserCompleteReplicaLayoutEvidence = Object.freeze({ run });
