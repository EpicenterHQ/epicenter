/**
 * What is happening right now: whether a recording is running, which
 * recordings are being transcribed or cleaned up, and which recording the
 * feed shows open. This is the one place the record, stop, save,
 * transcribe, clean up, copy sequence is written.
 */
import { timeId } from '@epicenter/app/time';
import { toastOnError } from '@epicenter/ui/toast-on-error';
import { SvelteSet } from 'svelte/reactivity';
import { toast } from 'svelte-sonner';
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { runMutation, runQuery } from 'wellcrafted/query';
import { tryAsync } from 'wellcrafted/result';
import { goto } from '$app/navigation';
import {
	cleanupInstructions,
	cleanupTimeoutMs,
	DEFAULT_PROMPT,
	hintPrompt,
	parseDictionary,
	rejectCleaned,
	replaceWords,
	shouldClean,
} from './cleanup';
import { cleanupServer } from './data/settings';
import { CLEANUP_PROMPT, DICTIONARY } from './data/text-files';
import { copyText, recorder, servers } from './platform';
import { type EndedReason, HEARD } from './platform/recorder/recorder';
import {
	queryClient,
	recordingsMutations,
	settingsQueries,
	textFilesQueries,
} from './queries';

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

/** The settings, from the cache once they are read; none set when they cannot be read. */
async function currentSettings() {
	const { data } = await runQuery(queryClient, settingsQueries.read());
	return data ?? {};
}

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
	/** The recordings whose text is with the cleanup model now; each is also in `transcribing`. */
	const cleaning = new SvelteSet<string>();
	/** The microphone's latest level while recording, from 0 to 1. */
	let level = $state(0);
	/** When the microphone last sent anything above silence during this recording. */
	let heardAt = $state<number>();

	async function start() {
		status = { kind: 'starting' };
		level = 0;
		heardAt = undefined;
		const { microphone } = await currentSettings();
		const { error } = await recorder.start(timeId(), {
			device: microphone ?? null,
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
		const saved = await runMutation(queryClient, recordingsMutations.add, data);
		if (saved.error) return toastOnError(saved, 'Could not save the recording');
		await transcribe(data.id);
	}

	/**
	 * Send the recording `id` to the server, clean up its transcript, save it
	 * and copy it. With no server set, say the recording is kept and where
	 * to set one.
	 *
	 * The order is fixed: the dictionary's words go as hints, its
	 * replacements apply to the text, which is saved before anything else;
	 * then the cleanup model, when set up, gets a few seconds to clean it up,
	 * and the replacements apply again. When cleanup is skipped, fails, or
	 * answers something it cannot trust, the person gets the text without it.
	 */
	async function transcribe(id: string) {
		const settings = await currentSettings();
		const { server } = settings;
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
		// Deleting the recording takes its id out of `transcribing`; nothing
		// is written for it after that.
		const gone = () => !transcribing.has(id);
		try {
			const words = parseDictionary(
				(await runQuery(queryClient, textFilesQueries.read(DICTIONARY))).data ??
					'',
			);
			const { data: heard, error } = await servers.transcribe(
				id,
				server,
				hintPrompt(words.hints),
			);
			if (gone()) return;
			if (error) {
				toast.error('Could not transcribe', {
					description: error.message,
					action: error.name === 'Unauthorized' ? openSettings : undefined,
				});
				return;
			}
			if (!heard) {
				toast.info('No speech was heard');
				return;
			}
			const replaced = replaceWords(heard, words.replacements);
			const saved = await save({ id, transcript: replaced, original: heard });
			if (saved.error)
				return toastOnError(saved, 'Could not save the transcript');

			let delivered = replaced;
			/** Why the text went out without cleanup, when cleanup was asked to run. */
			let notCleaned: string | undefined;
			let unauthorized = false;
			const cleanup = cleanupServer(settings);
			if (cleanup && shouldClean(replaced)) {
				cleaning.add(id);
				const prompt =
					(await runQuery(queryClient, textFilesQueries.read(CLEANUP_PROMPT)))
						.data ?? DEFAULT_PROMPT;
				const { data: cleaned, error } = await servers.complete(cleanup, {
					instructions: cleanupInstructions(prompt, words.hints),
					text: replaced,
					timeoutMs: cleanupTimeoutMs(replaced),
				});
				cleaning.delete(id);
				if (gone()) return;
				if (error) {
					notCleaned = error.message;
					unauthorized = error.name === 'Unauthorized';
				} else notCleaned = rejectCleaned(cleaned, replaced);
				if (!error && !notCleaned) {
					delivered = replaceWords(cleaned, words.replacements);
					// The text without cleanup is already saved; copy the cleaned-up
					// text even when saving it fails, and say so.
					const saved = await save({
						id,
						transcript: delivered,
						original: heard,
					});
					if (saved.error)
						toastOnError(saved, 'Could not save the cleaned-up text');
				}
			}

			const copied = await tryAsync({
				try: () => copyText(delivered),
				catch: (cause) => DictationError.CopyFailed({ cause }),
			});
			if (copied.error)
				return toastOnError(copied, 'Could not copy the transcript');
			if (notCleaned)
				return toast.success('Copied without cleanup', {
					description: notCleaned,
					action: unauthorized ? openSettings : undefined,
				});
			toast.success('Copied', {
				action:
					delivered === heard
						? undefined
						: { label: 'Use original', onClick: () => copyOriginal(heard) },
			});
		} finally {
			transcribing.delete(id);
			cleaning.delete(id);
		}
	}

	/** Save a transcript of a recording, in the recordings' one write queue. */
	const save = (change: {
		id: string;
		transcript: string;
		original?: string;
	}) => runMutation(queryClient, recordingsMutations.setTranscript, change);

	/** Copy `text`, the server's own words, instead of the cleaned-up text. */
	async function copyOriginal(text: string) {
		const copied = await tryAsync({
			try: () => copyText(text),
			catch: (cause) => DictationError.CopyFailed({ cause }),
		});
		if (copied.error)
			return toastOnError(copied, 'Could not copy the original');
		toast.success('Copied the original');
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

		/** Whether the recording `id`'s text is with the cleanup model now. */
		isCleaning(id: string) {
			return cleaning.has(id);
		},

		/** Transcribe the recording `id`, then clean up, save and copy its text. */
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
