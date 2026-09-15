import type { ApplicationRuntime } from './index.js';
import { createWebviewBlobs } from '@epicenter/blobs/webview';
import { resources } from './platform/epicenter-host.js';
import { createDesktopRecording } from './recording/desktop.js';
import { invoke } from '@tauri-apps/api/core';
import { blobDestination } from '@epicenter/blobs/native';

// Shared by every library factory in this document, never reset on library close.
let transferSequence = 0;

/** Native capture and host access to the same app-scoped files. */
export const epicenterHost: ApplicationRuntime = {
	...resources,
	blobs(options) {
		const destination = blobDestination(options.appId, options.replica);
		let epoch: Promise<number> | undefined;
		return createWebviewBlobs({
			...options,
			async nativeTransfer(direction, storageId, expected, ticket, signal) {
				if (signal.aborted)
					throw { kind: 'transport', cause: 'Attachment transfer cancelled.' };
				epoch ??= invoke<number>('attachment_transfer_epoch').catch((cause) => {
					epoch = undefined;
					throw cause;
				});
				const admittedEpoch = await epoch;
				if (signal.aborted)
					throw { kind: 'transport', cause: 'Attachment transfer cancelled.' };
				if (transferSequence === Number.MAX_SAFE_INTEGER)
					throw {
						kind: 'transport',
						cause: 'Transfer request sequence exhausted.',
					};
				const requestId = String(++transferSequence);
				let cancellation:
					| Promise<{ ok: true } | { ok: false; cause: unknown }>
					| undefined;
				const cancel = () => {
					cancellation ??= invoke('cancel_attachment_transfer', {
						epoch: admittedEpoch,
						requestId,
					}).then(
						() => ({ ok: true as const }),
						(cause) => ({ ok: false as const, cause }),
					);
				};
				signal.addEventListener('abort', cancel, { once: true });
				try {
					await invoke('transfer_attachment', {
						epoch: admittedEpoch,
						requestId,
						destination,
						storageId,
						direction,
						expected,
						ticket,
					});
					if (signal.aborted)
						throw {
							kind: 'transport',
							cause: 'Attachment transfer cancelled.',
						};
				} finally {
					signal.removeEventListener('abort', cancel);
					const cancelled = await cancellation;
					if (cancelled && !cancelled.ok)
						throw {
							kind: 'transport',
							cause: 'Native transfer cancellation failed.',
							error: cancelled.cause,
						};
				}
			},
			publishNative: (fileId, storageId, originGeneration) =>
				invoke('publish_recording_file', {
					fileId,
					storageId,
					originGeneration,
					destination,
				}),
		});
	},
	recording: createDesktopRecording,
};

export { createEpicenterHostAppAi } from './ai-connections.epicenter-host.js';
