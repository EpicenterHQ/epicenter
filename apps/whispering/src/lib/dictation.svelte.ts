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
import { cleanupServer, DEFAULTS, transcriber } from './data/settings';
import { CLEANUP_PROMPT, DICTIONARY } from './data/text-files';
import type { Fix, HandsFree, Outcome, Take, Trigger } from './dictation-view';
import { copyText, local, media, paste, recorder, servers } from './platform';
import {
	type EndedReason,
	HEARD,
	type HeardTake,
	type StoppedRecording,
} from './platform/recorder/recorder';
import type { ShortcutName } from './platform/shortcuts/shortcuts';
import {
	queryClient,
	recordingsMutations,
	settingsQueries,
	textFilesQueries,
} from './queries';
import { sounds } from './sounds';

/** A hold-to-talk press shorter than this is not a take. */
const TAP_MS = 300;

/**
 * A take hands-free started with less voice in it than this was a cough, a
 * door or a key press, and is deleted without being transcribed. A short
 * word ("yes") runs longer.
 */
const MIN_VOICED_MS = 150;

/**
 * How long a finished take waits for the takes before it to be delivered.
 * Past this it goes out of turn, so one stuck request cannot hold back
 * everything said after it.
 */
const TURN_WAIT_MS = 30_000;

/** How long the app in front gets to take a paste before the clipboard changes again. */
const PASTE_LANDS_MS = 150;

const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** How long a take may send only silence before the screens point it out. */
const QUIET_MS = 3000;

/** What a browser tab says of hands-free, which the recorder plugin does. */
const NO_HANDS_FREE: HandsFree = {
	kind: 'unavailable',
	why: 'Hands-free needs the desktop app.',
};

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

/** The settings, from the cache once they are read; the defaults when they cannot be read. */
async function currentSettings() {
	const { data } = await runQuery(queryClient, settingsQueries.read());
	return data ?? DEFAULTS;
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
	/**
	 * Whether hands-free holds the microphone open. It is on for this run
	 * of the app only: nothing in the settings opens a microphone at launch.
	 */
	let listening = $state(false);
	/** Whether the hold-to-talk keys are down now. */
	let holding = false;
	/** Turning hands-free on and off, one at a time and in the order asked. */
	let switching: Promise<void> = Promise.resolve();
	/** What this hands-free session has delivered so far, phrase by phrase. */
	let session: string[] = [];
	/** Resolves when the latest finished take has been delivered. */
	let lastDelivery: Promise<void> = Promise.resolve();
	/** What media pause paused, to play again after the take. */
	let pausedMedia: string[] = [];

	/** Pause music and video for a take, when the settings ask. */
	async function pauseMedia() {
		if ((await currentSettings())['output.pauseMedia'])
			pausedMedia = await media.pause();
	}

	/** Play again what `pauseMedia` paused. */
	function resumeMedia() {
		const paused = pausedMedia;
		pausedMedia = [];
		if (paused.length > 0) void media.resume(paused);
	}

	/** Play the start or the stop sound, when the settings ask. */
	async function sound(which: 'start' | 'stop') {
		if ((await currentSettings())['output.sounds']) sounds[which]();
	}

	async function start(trigger: Trigger) {
		take = { kind: 'starting' };
		level = 0;
		silent = false;
		let heardAt = Date.now();
		const { microphone } = await currentSettings();
		await pauseMedia();
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
			resumeMedia();
			// A chosen microphone that is unplugged is refused, never swapped
			// for another, so point to where another can be chosen.
			if (error.name === 'NoInputDevice' || error.name === 'InputUnavailable')
				return toast.error('Could not start recording', {
					description: error.message,
					action: openSettings,
				});
			return toastOnError(error, 'Could not start recording');
		}
		// Timed from here, when the microphone is open: the clock, and a hold's
		// length, count what could be recorded.
		heardAt = Date.now();
		take = { kind: 'recording', startedAt: heardAt, trigger };
		// Let go while the microphone was opening: nothing was said into it.
		if (trigger === 'hold' && !holding) return cancel();
		void sound('start');
	}

	async function stop() {
		if (take.kind !== 'recording') return;
		take = { kind: 'stopping' };
		const { data, error } = await recorder.stop();
		take = { kind: 'idle' };
		resumeMedia();
		void sound('stop');
		if (error) return toastOnError(error, 'Could not finish the recording');
		await keep(data);
	}

	/**
	 * Save the finished take `recording`, then transcribe and deliver it.
	 * `voice` is a take hands-free started on its own.
	 *
	 * Takes are transcribed side by side and delivered in the order they
	 * were made: each waits for the one before it, so a long sentence that
	 * takes longer to transcribe still lands before the short one after it.
	 */
	async function keep(
		{ id, durationMs }: StoppedRecording,
		{ voice = false } = {},
	) {
		// Taken now, before anything is awaited, so turns follow take order.
		const before = lastDelivery;
		let delivered = () => {};
		lastDelivery = new Promise<void>((done) => {
			delivered = done;
		});
		try {
			const saved = await runMutation(queryClient, recordingsMutations.add, {
				id,
				durationMs,
			});
			if (saved.error) {
				outcome = {
					kind: 'failed',
					id,
					label: 'Not saved',
					why: saved.error.message,
				};
				return toastOnError(saved, 'Could not save the recording');
			}
			void forgetOld();
			await transcribe(id, {
				voice,
				turn: Promise.race([before, wait(TURN_WAIT_MS)]),
			});
		} finally {
			delivered();
		}
	}

	/** Delete the recordings older than the settings keep, if they keep a limit. */
	async function forgetOld() {
		const keepDays = (await currentSettings())['recordings.keepDays'];
		if (keepDays === null) return;
		const deleted = await runMutation(
			queryClient,
			recordingsMutations.deleteOlderThan,
			{ keepDays },
		);
		if (deleted.error) toastOnError(deleted, 'Could not delete old recordings');
	}

	/**
	 * Keep a take hands-free heard, unless it holds too little voice to be
	 * speech: that one is deleted here, before any model or server hears it.
	 */
	async function keepHeard({ id, durationMs, voicedMs }: HeardTake) {
		if (voicedMs >= MIN_VOICED_MS)
			return keep({ id, durationMs }, { voice: true });
		// The one place audio is deleted unasked, so it always leaves a line.
		console.info(
			`Hands-free dropped take ${id}: a voice for ${voicedMs} ms of ${durationMs} ms.`,
		);
		const removed = await runMutation(queryClient, recordingsMutations.delete, {
			id,
		});
		if (removed.error)
			toastOnError(removed, 'Could not throw the recording away');
	}

	/**
	 * Turn hands-free on: the microphone stays open, and each phrase spoken
	 * is a take that ends on a pause and is delivered like any other. The
	 * next phrase can start while the last one is transcribed. Music stays
	 * paused for as long as it listens, since a song would be heard as speech.
	 */
	async function listen() {
		const handsFree = recorder.handsFree;
		if (!handsFree || listening || take.kind !== 'idle') return;
		listening = true;
		level = 0;
		silent = false;
		session = [];
		const { microphone } = await currentSettings();
		await pauseMedia();
		const { error } = await handsFree.start({
			device: microphone ?? null,
			onLevel: (next) => {
				level = next;
			},
			onSpeech: () => {
				if (listening)
					take = { kind: 'recording', startedAt: Date.now(), trigger: 'voice' };
			},
			onPhrase: (heard) => {
				take = { kind: 'idle' };
				void keepHeard(heard);
			},
			onEnded: (reason) => {
				toast.warning('Hands-free stopped', {
					description: `${ENDED[reason]} What was recorded is kept.`,
				});
				setHandsFree(false);
			},
		});
		if (error) {
			listening = false;
			resumeMedia();
			if (error.name === 'NoInputDevice' || error.name === 'InputUnavailable')
				return toast.error('Could not start listening', {
					description: error.message,
					action: openSettings,
				});
			return toastOnError(error, 'Could not start listening');
		}
		void sound('start');
	}

	/** Turn hands-free off, keeping and delivering a phrase under way. */
	async function unlisten() {
		const handsFree = recorder.handsFree;
		if (!handsFree || !listening) return;
		listening = false;
		if (take.kind === 'recording') take = { kind: 'stopping' };
		const { data, error } = await handsFree.stop();
		take = { kind: 'idle' };
		level = 0;
		resumeMedia();
		void sound('stop');
		if (error) return toastOnError(error, 'Could not finish the recording');
		if (data) void keepHeard(data);
	}

	/**
	 * Turn hands-free on or off. Each change waits for the one before it,
	 * so on, off and on again in a hurry end with it on and one microphone
	 * open, never with a microphone open that no switch shows.
	 */
	function setHandsFree(on: boolean) {
		switching = switching.then(async () => {
			await (on ? listen() : unlisten());
		});
	}

	/**
	 * Put the take `id`'s `text` where the person wants it, and say where
	 * it went. It always reaches the clipboard. With paste at the cursor
	 * on, the paste keys are then pressed in the app in front, unless that
	 * app is Whispering itself; a paste that cannot be made leaves the text
	 * on the clipboard and says so.
	 *
	 * In a hands-free session the clipboard ends up holding everything said
	 * so far, joined by spaces; each phrase is pasted on its own, with a
	 * space before every one but the first.
	 *
	 * Answers where the text went, or undefined when it could not be copied.
	 */
	async function deliver(id: string, text: string, voice: boolean) {
		const settings = await currentSettings();
		const pasting =
			settings['output.paste'] && paste.available && !document.hasFocus();
		const piece = voice && session.length > 0 ? ` ${text}` : text;
		if (voice) session.push(text);
		const whole = voice ? session.join(' ') : text;
		const copy = (copied: string) =>
			tryAsync({
				try: () => copyText(copied),
				catch: (cause) => DictationError.CopyFailed({ cause }),
			});

		const copied = await copy(pasting ? piece : whole);
		if (copied.error) {
			outcome = {
				kind: 'failed',
				id,
				label: 'Not copied',
				why: copied.error.message,
			};
			toastOnError(copied, 'Could not copy the transcript');
			return undefined;
		}
		if (!pasting) {
			outcome = { kind: 'delivered', id, to: 'clipboard', at: Date.now() };
			return 'clipboard' as const;
		}
		const pasted = await paste.press();
		// The app in front reads the clipboard a moment after the keys.
		if (whole !== piece) {
			if (!pasted.error) await wait(PASTE_LANDS_MS);
			await copy(whole);
		}
		if (pasted.error) {
			outcome = { kind: 'copiedInstead', id, why: pasted.error.message };
			return 'clipboard' as const;
		}
		outcome = { kind: 'delivered', id, to: 'cursor', at: Date.now() };
		return 'cursor' as const;
	}

	/**
	 * Transcribe the recording `id`, on this computer or with the server,
	 * clean up its transcript, save it and copy it. With neither set up, say the recording is kept and where
	 * to set one.
	 *
	 * The order is fixed: the dictionary's words go as hints, its
	 * replacements apply to the text, which is saved before anything else;
	 * then the cleanup model, when set up, gets a few seconds to clean it up,
	 * and the replacements apply again. When cleanup is skipped, fails, or
	 * answers something it cannot trust, the person gets the text without it.
	 */
	async function transcribe(
		id: string,
		{
			voice = false,
			turn = Promise.resolve(),
		}: {
			/** A take hands-free started: the pill reports it, with no toasts. */
			voice?: boolean;
			/** Resolves when the takes before this one have been delivered. */
			turn?: Promise<unknown>;
		} = {},
	) {
		const settings = await currentSettings();
		const chosen = transcriber(settings);
		if (!chosen) {
			outcome = {
				kind: 'failed',
				id,
				label: 'Needs a server',
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
			const prompt = hintPrompt(words.hints);
			const { data: heard, error } =
				chosen.kind === 'local'
					? await local.transcribe(id, chosen.model, prompt)
					: await servers.transcribe(id, chosen, prompt);
			if (gone()) return;
			if (error) {
				/** What Settings can fix, and what the pill calls it. */
				const needs =
					error.name === 'Unauthorized'
						? 'Needs a key'
						: error.name === 'ModelMissing'
							? 'Needs a model'
							: error.name === 'Unavailable'
								? 'Needs a server'
								: undefined;
				outcome = {
					kind: 'failed',
					id,
					label: needs ?? 'Not transcribed',
					why: error.message,
					fix: needs ? SERVER_SETTINGS : undefined,
				};
				toast.error('Could not transcribe', {
					description: error.message,
					action: needs ? openSettings : undefined,
				});
				return;
			}
			if (!heard) {
				outcome = {
					kind: 'failed',
					id,
					label: 'No speech heard',
					why: 'No speech was heard.',
				};
				// The recording is kept either way; a take nobody started by
				// hand does not also interrupt with a message.
				if (!voice) toast.info('No speech was heard');
				return;
			}
			const replaced = replaceWords(heard, words.replacements);
			const saved = await save({ id, transcript: replaced, original: heard });
			if (saved.error) {
				outcome = {
					kind: 'failed',
					id,
					label: 'Not saved',
					why: saved.error.message,
				};
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

			await turn;
			if (gone()) return;
			const went = await deliver(id, delivered, voice);
			// The pill and Home say where each hands-free phrase went.
			if (!went || voice) return;
			const done = went === 'cursor' ? 'Pasted' : 'Copied';
			if (notCleaned)
				return toast.success(`${done} without cleanup`, {
					description: notCleaned,
					action: unauthorized ? openSettings : undefined,
				});
			toast.success(done, {
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

	/** Stop the take under way and delete what it recorded. */
	async function cancel() {
		if (take.kind !== 'recording' || listening) return;
		take = { kind: 'stopping' };
		const { data, error } = await recorder.stop();
		take = { kind: 'idle' };
		resumeMedia();
		if (error) return toastOnError(error, 'Could not stop the recording');
		const removed = await runMutation(queryClient, recordingsMutations.delete, {
			id: data.id,
		});
		if (removed.error)
			return toastOnError(removed, 'Could not throw the recording away');
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
		level: () => level,
		silent: () => silent,
		handsFree: (): HandsFree =>
			!recorder.handsFree
				? NO_HANDS_FREE
				: listening
					? { kind: 'listening' }
					: { kind: 'off' },
		outcome: () => outcome,

		/** Start a take, or stop the one under way; `trigger` says what asked. */
		toggle(trigger: Trigger = 'button') {
			// While hands-free listens, the button and the shortcut turn it off.
			if (listening) return setHandsFree(false);
			if (take.kind === 'idle') return void start(trigger);
			if (take.kind === 'recording') return void stop();
		},

		/**
		 * The hold-to-talk keys went down, or came up. Down starts a take
		 * and up finishes it; one let go within `TAP_MS` was a slip of the
		 * hand, and is thrown away.
		 */
		hold(down: boolean) {
			holding = down;
			if (down) {
				if (take.kind === 'idle' && !listening) void start('hold');
				return;
			}
			if (take.kind !== 'recording' || take.trigger !== 'hold') return;
			void (Date.now() - take.startedAt < TAP_MS ? cancel() : stop());
		},

		/**
		 * A global shortcut went down, or came up. This is the one place that
		 * says what each does.
		 */
		press(name: ShortcutName, down: boolean) {
			if (name === 'hold') return this.hold(down);
			if (!down) return;
			if (name === 'toggle') return this.toggle('shortcut');
			setHandsFree(!listening);
		},

		cancel: () => void cancel(),

		/** Delete the recordings older than the settings keep; the app's frame asks as it opens. */
		forgetOld: () => void forgetOld(),

		dismiss() {
			outcome = { kind: 'none' };
		},

		/** Open `href` in this window; the pill's window brings this one forward first. */
		show(href: string) {
			void goto(href);
		},

		setHandsFree,

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
