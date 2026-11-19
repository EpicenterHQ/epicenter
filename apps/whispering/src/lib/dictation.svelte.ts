/**
 * What is happening right now: whether a recording is running, and which
 * recording the feed shows open. This is the one place the record, stop,
 * save sequence is written.
 */
import { timeId } from '@epicenter/app/time';
import { toastOnError } from '@epicenter/ui/toast-on-error';
import { toast } from 'svelte-sonner';
import { runMutation } from 'wellcrafted/query';
import { queryClient, recordingsMutations } from './queries';
import { type EndedReason, recorder } from './recorder';

type Status =
	| { kind: 'idle' }
	| { kind: 'starting' }
	| { kind: 'recording'; startedAt: number }
	| { kind: 'stopping' };

const ENDED: Record<EndedReason, string> = {
	deviceDisconnected: 'The microphone was disconnected.',
	permissionRevoked: 'Microphone access was turned off.',
	streamFailed: 'The microphone stopped working.',
	storageFailed: 'The disk could not take any more audio.',
};

function createDictation() {
	let status = $state<Status>({ kind: 'idle' });
	/**
	 * The recording the feed shows open: the one the person opened last, or
	 * the one that just finished, whichever came later. Undefined until
	 * either happens, when the feed opens the newest.
	 */
	let openId = $state<string>();

	async function start() {
		status = { kind: 'starting' };
		const { error } = await recorder.start(timeId(), (reason) => {
			toast.warning('Recording stopped', {
				description: `${ENDED[reason]} What was recorded is kept.`,
			});
			void stop();
		});
		if (error) {
			status = { kind: 'idle' };
			return toastOnError(error, 'Could not start recording');
		}
		status = { kind: 'recording', startedAt: Date.now() };
	}

	async function stop() {
		if (status.kind !== 'recording') return;
		status = { kind: 'stopping' };
		const { data, error } = await recorder.stop();
		status = { kind: 'idle' };
		if (error) return toastOnError(error, 'Could not finish the recording');
		openId = data.id;
		const saved = await runMutation(
			queryClient,
			recordingsMutations.addNote,
			data,
		);
		toastOnError(saved, 'Could not save the recording');
	}

	return {
		get status() {
			return status;
		},
		get openId() {
			return openId;
		},

		/** Start recording, or stop the recording that is running. */
		toggle() {
			if (status.kind === 'idle') return start();
			if (status.kind === 'recording') return stop();
		},

		/** Show the recording `id` open in the feed. */
		open(id: string) {
			openId = id;
		},
	};
}

export const dictation = createDictation();
