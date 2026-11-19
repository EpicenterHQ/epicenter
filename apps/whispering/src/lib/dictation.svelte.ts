/**
 * What is happening right now: whether a recording is running, which
 * recording just finished, and transcript edits not yet saved. This is the
 * one place the record, stop, save sequence is written.
 *
 * An edit lives here as a draft until its save finishes. A refetch of the
 * list never overwrites a draft, and an edit made while the save was in
 * flight stays a draft.
 */
import { timeId } from '@epicenter/app/time';
import { toastOnError } from '@epicenter/ui/toast-on-error';
import { SvelteMap } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import { runMutation } from 'wellcrafted/query';
import { queryClient, recordingsMutations } from './queries';
import { type EndedReason, recorder } from './recorder';
import type { Recording } from './recordings';

type Status =
	| { kind: 'idle' }
	| { kind: 'starting' }
	| { kind: 'recording'; id: string; startedAt: number }
	| { kind: 'stopping' };

const ENDED: Record<EndedReason, string> = {
	deviceDisconnected: 'The microphone was disconnected.',
	permissionRevoked: 'Microphone access was turned off.',
	streamFailed: 'The microphone stopped working.',
	storageFailed: 'The disk could not take any more audio.',
};

function createDictation() {
	let status = $state<Status>({ kind: 'idle' });
	/** The recording that finished last, which the feed opens. */
	let latest = $state<string | undefined>();
	const drafts = new SvelteMap<string, string>();

	async function start() {
		const id = timeId();
		status = { kind: 'starting' };
		const { error } = await recorder.start(id, (reason) => {
			toast.warning('Recording stopped', {
				description: `${ENDED[reason]} What was recorded is kept.`,
			});
			void stop();
		});
		if (error) {
			status = { kind: 'idle' };
			return toastOnError(error, 'Could not start recording');
		}
		status = { kind: 'recording', id, startedAt: Date.now() };
	}

	async function stop() {
		if (status.kind !== 'recording') return;
		status = { kind: 'stopping' };
		const { data, error } = await recorder.stop();
		status = { kind: 'idle' };
		if (error) return toastOnError(error, 'Could not finish the recording');
		latest = data.id;
		const saved = await runMutation(
			queryClient,
			recordingsMutations.create,
			data,
		);
		toastOnError(saved, 'Could not save the recording');
	}

	return {
		get status() {
			return status;
		},
		get latest() {
			return latest;
		},

		/** Start recording, or stop the recording that is running. */
		toggle() {
			if (status.kind === 'idle') return start();
			if (status.kind === 'recording') return stop();
		},

		/** The transcript as the person sees it: their unsaved edit, else the note's. */
		transcriptOf(recording: Recording) {
			return drafts.get(recording.id) ?? recording.transcript;
		},

		edit(id: string, text: string) {
			drafts.set(id, text);
		},

		/** Save the draft of `id`, if it has one. The draft goes once its text is on disk. */
		async save(id: string) {
			const transcript = drafts.get(id);
			if (transcript === undefined) return;
			const saved = await runMutation(
				queryClient,
				recordingsMutations.setTranscript,
				{ id, transcript },
			);
			if (saved.error)
				return toastOnError(saved, 'Could not save the transcript');
			if (drafts.get(id) === transcript) drafts.delete(id);
		},

		/** Save every draft: before the page goes away. */
		saveAll() {
			for (const id of drafts.keys()) void this.save(id);
		},

		/** Forget a deleted recording's draft, so nothing writes its note back. */
		discard(id: string) {
			drafts.delete(id);
		},
	};
}

export const dictation = createDictation();
