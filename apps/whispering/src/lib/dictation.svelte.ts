/**
 * What is happening right now: whether a recording is running, which
 * recordings are being transcribed, and which recording the feed shows open.
 * This is the one place the record, stop, save, transcribe, copy sequence is
 * written.
 */
import { timeId } from '@epicenter/app/time';
import { toastOnError } from '@epicenter/ui/toast-on-error';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { SvelteSet } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { runMutation } from 'wellcrafted/query';
import { tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import { queryClient, recordingsMutations } from './queries';
import { type EndedReason, HEARD, recorder } from './recorder';
import { settings } from './settings.svelte';
import { transcription } from './transcription';

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

const DictationError = defineErrors({
	CopyFailed: ({ cause }: { cause: unknown }) => ({
		message: `The transcript is saved, but it could not be copied: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

const openSettings = {
	label: 'Open settings',
	onClick: () => goto('/settings'),
};

function createDictation() {
	let status = $state<Status>({ kind: 'idle' });
	/**
	 * The recording the feed shows open: the one the person opened last, or
	 * the one that just finished, whichever came later. Undefined until
	 * either happens, when the feed opens the newest.
	 */
	let openId = $state<string>();
	/**
	 * The recordings whose audio is with the server now. It is apart from
	 * `status`, so the next take can start while the last one transcribes.
	 * Deleting a recording takes it out, and a transcript that arrives for
	 * an id no longer here is dropped.
	 */
	const transcribing = new SvelteSet<string>();
	/** The microphone's latest level while recording, from 0 to 1. */
	let level = $state(0);
	/** When the microphone last sent anything above silence during this recording. */
	let heardAt = $state<number>();

	async function start() {
		status = { kind: 'starting' };
		level = 0;
		heardAt = undefined;
		const { error } = await recorder.start(timeId(), {
			device: settings.microphone ?? null,
			onEnded: (reason) => {
				toast.warning('Recording stopped', {
					description: `${ENDED[reason]} What was recorded is kept.`,
				});
				void stop();
			},
			onLevel: (next) => {
				level = next;
				if (next > HEARD) heardAt = Date.now();
			},
		});
		if (error) {
			status = { kind: 'idle' };
			// A chosen microphone that is unplugged is refused, never swapped
			// for another, so point to where another can be chosen.
			if (error.name === 'NoInputDevice' || error.name === 'InputUnavailable')
				return toast.error('Could not start recording', {
					description: error.message,
					action: openSettings,
				});
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
		if (saved.error) return toastOnError(saved, 'Could not save the recording');
		await transcribe(data.id);
	}

	/**
	 * Send the recording `id` to the server, save its transcript and copy
	 * it. With no server set, say the recording is kept and where to set one.
	 */
	async function transcribe(id: string) {
		const server = settings.server;
		if (!server) {
			toast.info('Recording kept', {
				description:
					'Add a transcription server to get text after each recording.',
				action: openSettings,
			});
			return;
		}
		if (transcribing.has(id)) return;
		transcribing.add(id);
		const { data: text, error } = await transcription.transcribe(id, server);
		// The id is gone from the set only if the recording was deleted while
		// the server had it. A delete confirmed after this line queues behind
		// the save below: both run in the one recordings mutation scope.
		const deleted = !transcribing.delete(id);
		if (deleted) return;
		if (error) {
			toast.error('Could not transcribe', {
				description: error.message,
				action: error.name === 'Unauthorized' ? openSettings : undefined,
			});
			return;
		}
		if (!text) {
			toast.info('No speech was heard');
			return;
		}
		const saved = await runMutation(
			queryClient,
			recordingsMutations.setTranscript,
			{
				id,
				transcript: text,
			},
		);
		if (saved.error)
			return toastOnError(saved, 'Could not save the transcript');
		const copied = await tryAsync({
			try: () => writeText(text),
			catch: (cause) => DictationError.CopyFailed({ cause }),
		});
		if (copied.error)
			return toastOnError(copied, 'Could not copy the transcript');
		toast.success('Copied');
	}

	return {
		get status() {
			return status;
		},
		get openId() {
			return openId;
		},
		/** The microphone's latest level while recording, from 0 to 1. */
		get level() {
			return level;
		},
		/** When the microphone last sent sound during this recording; undefined until it does. */
		get heardAt() {
			return heardAt;
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

		/** Whether the recording `id` is with the server now. */
		isTranscribing(id: string) {
			return transcribing.has(id);
		},

		/** Transcribe the recording `id`, then save and copy its text. */
		transcribe,

		/**
		 * Drop the transcription of `id` under way, if any, so its text is
		 * not written after the recording is deleted. Call it before the delete.
		 */
		forget(id: string) {
			transcribing.delete(id);
		},
	};
}

export const dictation = createDictation();
