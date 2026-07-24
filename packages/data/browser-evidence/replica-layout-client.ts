import type {
	ReplicaLayoutEngineResult,
	ReplicaLayoutEvidenceDriver,
	ReplicaLayoutProfile,
	ReplicaLayoutWorkerMessage,
} from './replica-layout-contract.js';

declare global {
	interface Window {
		browserReplicaLayoutEvidence: ReplicaLayoutEvidenceDriver;
	}
}

function run(
	profile: ReplicaLayoutProfile,
	runId: string,
): Promise<ReplicaLayoutEngineResult> {
	const worker = new Worker(
		new URL('./replica-layout-worker.ts', import.meta.url),
		{
			type: 'module',
			name: `epicenter-replica-layout-${runId}`,
		},
	);
	return new Promise((resolve, reject) => {
		worker.addEventListener(
			'message',
			({ data: message }: MessageEvent<ReplicaLayoutWorkerMessage>) => {
				switch (message.type) {
					case 'progress':
						console.log(message.message);
						return;
					case 'result':
						worker.terminate();
						resolve(message.result);
						return;
					case 'error': {
						worker.terminate();
						const cause = new Error(message.message);
						cause.name = message.name;
						if (message.stack !== undefined) cause.stack = message.stack;
						reject(cause);
						return;
					}
				}
			},
		);
		worker.addEventListener('error', ({ message }) => {
			worker.terminate();
			reject(new Error(message || 'Browser replica layout worker failed'));
		});
		worker.postMessage({ type: 'run', profile, runId });
	});
}

window.browserReplicaLayoutEvidence = Object.freeze({ run });
