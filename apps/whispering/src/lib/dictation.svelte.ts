/**
 * What is happening right now: whether a recording is running, which
 * recordings are being transcribed or cleaned up, and what became of the
 * latest take. This is the one place the record, stop, save, transcribe,
 * clean up, copy sequence is written. Screens read it through
 * `DictationView` (`dictation-view.ts`), never this module's internals.
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
import type { Fix, HandsFree, Outcome, Take, Trigger } from './dictation-view';
import { copyText, recorder, servers } from './platform';
import { type EndedReason, HEARD } from './platform/recorder/recorder';
import {
	queryClient,
	recordingsMutations,
	settingsQueries,
	textFilesQueries,
} from './queries';

/** How long a take may send only silence before the screens point it out. */
const QUIET_MS = 3000;

/** Hands-free is designed (see the preview page) but not built yet. */
const HANDS_FREE: HandsFree = { kind: 'unavailable', why: 'Not built yet.' };

const SERVER_SETTINGS: Fix = {
	label: 'Set up transcription',
	href: '/settings/transcription',
};

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
	onClick: () => goto(SERVER_SETTINGS.href),
};

function createDictation() {
	let take = $state<Take>({ kind: 'idle' });
	let outcome = $state<Outcome>({ kind: 'none' });
	/**
	 * The recordings whose audio is with the server now. It is apart from
	 * `take`, so the next take can start while the last one transcribes.
	 * Deleting a recording takes it out, and a transcript that arrives for
	 * an id no longer here is dropped.
	 */
	const transcribing = new SvelteSet<string>();
	/** The recordings whose text is with the cleanup model now; each is also in `transcribing`. */
	const cleaning = new SvelteSet<string>();
	/** The microphone's latest level while recording, from 0 to 1. */
	let level = $state(0);
	/** Whether this take has sent only silence for `QUIET_MS`. */
	let silent = $state(false);

	async function start(trigger: Trigger) {
		take = { kind: 'starting' };
		level = 0;
		silent = false;
		const startedAt = Date.now();
		let heardAt = startedAt;
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
				const now = Date.now();
				if (next > HEARD) heardAt = now;
				silent = now - heardAt > QUIET_MS;
			},
		});
		if (error) {
			take = { kind: 'idle' };
			// A chosen microphone that is unplugged is refused, never swapped
			// for another, so point to where another can be chosen.
			if (error.name === 'NoInputDevice' || error.name === 'InputUnavailable')
				return toast.error('Could not start recording', {
					description: error.message,
					action: openSettings,
				});
			return toastOnError(error, 'Could not start recording');
		}
		take = { kind: 'recording', startedAt, trigger };
	}

	async function stop() {
		if (take.kind !== 'recording') return;
		take = { kind: 'stopping' };
		const { data, error } = await recorder.stop();
		take = { kind: 'idle' };
		if (error) return toastOnError(error, 'Could not finish the recording');
		const saved = await runMutation(queryClient, recordingsMutations.add, data);
		if (saved.error) {
			outcome = { kind: 'failed', id: data.id, why: saved.error.message };
			return toastOnError(saved, 'Could not save the recording');
		}
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
			outcome = {
				kind: 'failed',
				id,
				why: 'No transcription server is set.',
				fix: SERVER_SETTINGS,
			};
			toast.info('Recording kept', {
				description:
					'Add a transcription server to get text after each recording.',
				action: openSettings,
			});
			return;
		}
		if (transcribing.has(id)) return;
		transcribing.add(id);
		outcome = { kind: 'transcribing', id };
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
				outcome = {
					kind: 'failed',
					id,
					why: error.message,
					fix: error.name === 'Unauthorized' ? SERVER_SETTINGS : undefined,
				};
				toast.error('Could not transcribe', {
					description: error.message,
					action: error.name === 'Unauthorized' ? openSettings : undefined,
				});
				return;
			}
			if (!heard) {
				outcome = { kind: 'failed', id, why: 'No speech was heard.' };
				toast.info('No speech was heard');
				return;
			}
			const replaced = replaceWords(heard, words.replacements);
			const saved = await save({ id, transcript: replaced, original: heard });
			if (saved.error) {
				outcome = { kind: 'failed', id, why: saved.error.message };
				return toastOnError(saved, 'Could not save the transcript');
			}

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
			if (copied.error) {
				outcome = { kind: 'failed', id, why: copied.error.message };
				return toastOnError(copied, 'Could not copy the transcript');
			}
			outcome = { kind: 'delivered', id, to: 'clipboard' };
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
		take: () => take,
		/** The start-and-stop shortcut is fixed in `main.rs`; hold to talk is not built yet. */
		keys: () => ({ toggle: '⌘⇧;' }),
		level: () => level,
		silent: () => silent,
		handsFree: () => HANDS_FREE,
		outcome: () => outcome,

		/** Start a take, or stop the one under way; `trigger` says what asked. */
		toggle(trigger: Trigger = 'button') {
			if (take.kind === 'idle') return void start(trigger);
			if (take.kind === 'recording') return void stop();
		},

		setHandsFree(_on: boolean) {},

		/** Whether the recording `id` is with the server now. */
		isTranscribing(id: string) {
			return transcribing.has(id);
		},

		/** Whether the recording `id`'s text is with the cleanup model now. */
		isCleaning(id: string) {
			return cleaning.has(id);
		},

		/** Transcribe the recording `id`, then clean up, save and copy its text. */
		transcribe: (id: string) => void transcribe(id),

		/**
		 * Drop the transcription of `id` under way, if any, so its text is
		 * not written after the recording is deleted. Call it before the delete.
		 */
		forget(id: string) {
			transcribing.delete(id);
			if (outcome.kind !== 'none' && outcome.id === id)
				outcome = { kind: 'none' };
		},
	};
}

export const dictation = createDictation();
