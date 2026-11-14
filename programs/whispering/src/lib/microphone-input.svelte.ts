/**
 * The microphone a session records from, and the test of it.
 *
 * The choice is the system default or one microphone, identified by the ID
 * the recorder lists it under: the shell's on the desktop, the browser's in
 * a browser. It is kept on this device through the services and
 * applies to the next recording: a recording that is running keeps the
 * microphone it opened, so the choice cannot be changed while one is
 * starting, running, or finishing. A choice whose ID is not listed stays the
 * choice. A name is not an identity, so no listed input is taken for it; the
 * person chooses again. The choice applies at once; saving it on the device
 * follows, one save at a time in the order chosen.
 *
 * Nothing here asks for microphone access on its own. Listing reads what the
 * recorder already lists; `allow` and `startTest` are the actions that open a
 * microphone, and each is something the person pressed.
 *
 * Those two are the only things here that open a microphone, and they share
 * one owner: at most one of them is under way, never beside a recording, and
 * `release` ends whichever it is. A microphone that opens after the
 * release is released when it arrives. A test reads a level and nothing
 * else: no audio is recorded, sent, or saved.
 */
import {
	type InputListing,
	type Meter,
	RecorderError,
	type RecordingEndedReason,
	type RecordingInput,
} from '@epicenter/recorder';
import type { CaptureDevice } from './capture.js';
import type { MicrophonePreferences } from './microphone-preference.js';

export type MicrophoneInput = ReturnType<typeof createMicrophoneInput>;

/** What is known of the inputs the recorder lists. */
export type InputList =
	/** Nothing has been listed yet. */
	| { readonly kind: 'unread' }
	| { readonly kind: 'unsupported'; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string }
	| ({ readonly kind: 'listed' } & InputListing);

export type InputTest =
	| { readonly phase: 'idle' }
	| { readonly phase: 'opening' }
	| { readonly phase: 'running'; readonly label: string };

/**
 * How full the level bar is for an input's level (its RMS, 0 to 1). Speech
 * sits low on a linear scale; the root spreads it over the bar.
 */
const shown = (level: number) => Math.min(1, Math.sqrt(level) * 1.5);

const RECORDING =
	'A recording is using the microphone. Stop it before changing or testing the input.';

/** Why a microphone stopped on its own, said as a refusal to open it would be. */
const endedError = (reason: RecordingEndedReason, label: string) =>
	reason === 'permissionRevoked'
		? RecorderError.PermissionDenied().error
		: reason === 'deviceDisconnected'
			? RecorderError.InputUnavailable({ label }).error
			: RecorderError.Failed({
					cause: new Error(`The microphone stopped (${reason}).`),
				}).error;

export function createMicrophoneInput({
	capture,
	preferences,
	recording,
}: {
	capture: Pick<CaptureDevice, 'inputs'>;
	preferences: MicrophonePreferences;
	/** Whether a recording is starting, running, or finishing. */
	recording: () => boolean;
}) {
	const inputs = capture.inputs;
	let choice = $state.raw<RecordingInput | undefined>();
	let list = $state.raw<InputList>({ kind: 'unread' });
	let listing = $state(false);
	let level = $state(0);
	/** Why the last action here did not work, in the words shown. */
	let problem = $state<string | undefined>();
	let denied = $state(false);
	let preferenceProblem = $state<string | undefined>();

	let listSequence = 0;
	let closed = false;
	let unwatch: (() => void) | undefined;
	/**
	 * The one request that may open a microphone here: enabling, or a test
	 * that is opening or running. Aborting it releases whatever it opens.
	 */
	type Acquisition =
		| { kind: 'allow' | 'opening'; controller: AbortController }
		| {
				kind: 'running';
				controller: AbortController;
				meter: Meter;
				/** The name of the microphone the test opened. */
				label: string;
		  };
	let acquisition = $state.raw<Acquisition>();

	function report(error: RecorderError | null) {
		// A withdrawn request is not a failure to show.
		if (error?.name === 'Cancelled') return;
		problem = error?.message;
		if (error !== null) denied = error.name === 'PermissionDenied';
	}

	/**
	 * Every accepted save of the choice, joined in the order chosen. A save
	 * starts only when the one before it has answered, so the device ends
	 * holding the latest choice whatever order the answers would have come in.
	 */
	let saves: Promise<void> = Promise.resolve();
	let saveSequence = 0;

	/**
	 * Save a choice on this device, after any save already accepted. Only the
	 * latest choice reports: an older save's failure says nothing about the
	 * choice that replaced it.
	 */
	function persist(next: RecordingInput | undefined): Promise<void> {
		const sequence = ++saveSequence;
		preferenceProblem = undefined;
		saves = saves.then(async () => {
			const outcome = await preferences
				.setMicrophone(next)
				.catch((cause) =>
					cause instanceof Error ? cause.message : String(cause),
				);
			if (sequence === saveSequence) preferenceProblem = outcome;
		});
		return saves;
	}

	/**
	 * List the inputs again. This never asks for access. A previous listing
	 * stays on screen until this one answers.
	 */
	async function refresh() {
		if (closed) return;
		// Told about connected and removed inputs from the first listing on.
		unwatch ??= inputs.onInputsChange?.(() => void refresh()) ?? (() => {});
		const sequence = ++listSequence;
		listing = true;
		const { data: listed, error: listError } = await inputs.listInputs();
		if (sequence !== listSequence || closed) return;
		listing = false;
		if (listError !== null) {
			list =
				listError.name === 'Unavailable'
					? { kind: 'unsupported', message: listError.message }
					: { kind: 'failed', message: listError.message };
			return;
		}
		list = { kind: 'listed', ...listed };
		// Where names wait for access, names listed mean access is allowed,
		// whatever an earlier attempt said. The desktop shell names inputs
		// without access, so there only a microphone that opens clears a denial.
		if (listed.namesWithheld !== undefined && listed.inputs.length > 0)
			denied = false;
	}

	/**
	 * End whatever is opening or holding a microphone here: a pending enable,
	 * or a test that is opening or running. Safe to call when nothing is.
	 */
	function release() {
		const held = acquisition;
		acquisition = undefined;
		held?.controller.abort();
		if (held?.kind === 'running') void held.meter.close();
		level = 0;
	}

	/**
	 * Whether a microphone may be opened here now. A recording is said to be
	 * the reason; a request already under way here is simply not repeated.
	 */
	function mayOpen(): boolean {
		if (recording()) {
			problem = RECORDING;
			return false;
		}
		return acquisition === undefined;
	}

	return {
		/** The chosen microphone, or undefined for the system default. */
		get choice() {
			return choice;
		},
		get list() {
			return list;
		},
		/** Whether the inputs are being listed now. */
		get listing() {
			return listing;
		},
		get allowing() {
			return acquisition?.kind === 'allow';
		},
		/** Whether access can be asked for here: a browser's, never the desktop shell's, which asks itself. */
		canAllow: inputs.allow !== undefined,
		/**
		 * Whether the chosen microphone's ID is among those listed. Undefined
		 * while that cannot be told: nothing is listed by name yet, which is also
		 * what a WebView shows before access is allowed. An input with the same
		 * name under another ID is not the chosen one.
		 */
		get choiceListed(): boolean | undefined {
			const chosen = choice;
			if (chosen === undefined || list.kind !== 'listed') return undefined;
			if (list.inputs.length === 0) return undefined;
			return list.inputs.some((input) => input.deviceId === chosen.deviceId);
		},
		get test(): InputTest {
			if (acquisition?.kind === 'running')
				return { phase: 'running', label: acquisition.label };
			return { phase: acquisition?.kind === 'opening' ? 'opening' : 'idle' };
		},
		/** How full the running test's level bar is, from 0 to 1. */
		get level() {
			return level;
		},
		get problem() {
			return problem;
		},
		/** Whether the last attempt to open a microphone was refused access. */
		get denied() {
			return denied;
		},
		/** Why the choice could not be read or saved on this device. */
		get preferenceProblem() {
			return preferenceProblem;
		},

		/** Read the saved choice. Opens no microphone and lists nothing. */
		load() {
			if (closed) return;
			try {
				choice = preferences.microphone();
			} catch (cause) {
				preferenceProblem = `The saved microphone could not be read: ${cause instanceof Error ? cause.message : String(cause)}`;
			}
		},
		refresh,
		/**
		 * Ask for microphone access so inputs are listed by name. The system
		 * default microphone is opened and released at once. Only where
		 * `canAllow`.
		 */
		async allow() {
			const allow = inputs.allow;
			if (allow === undefined || closed || !mayOpen()) return;
			problem = undefined;
			const attempt: Acquisition = {
				kind: 'allow',
				controller: new AbortController(),
			};
			acquisition = attempt;
			const { error: allowError } = await allow({
				signal: attempt.controller.signal,
			});
			// Released while the recorder was answering. Whatever it opened is not kept.
			if (acquisition !== attempt) return;
			release();
			report(allowError);
			await refresh();
		},
		/**
		 * Choose the microphone the next recording uses, or undefined for the
		 * system default. A test under way is of the previous choice, so it ends.
		 */
		async select(next: RecordingInput | undefined) {
			if (closed) return;
			if (recording()) {
				problem = RECORDING;
				return;
			}
			release();
			problem = undefined;
			choice = next;
			await persist(next);
		},
		/** Open the chosen microphone and read its level until released. */
		async startTest() {
			if (closed || !mayOpen()) return;
			problem = undefined;
			const attempt: Acquisition = {
				kind: 'opening',
				controller: new AbortController(),
			};
			acquisition = attempt;
			const { data: opened, error: meterError } = await inputs.openMeter({
				input: choice,
				signal: attempt.controller.signal,
			});
			// Released, or released and started again, while the recorder was answering.
			if (acquisition !== attempt) {
				if (meterError === null) void opened.close();
				return;
			}
			if (meterError !== null) {
				release();
				report(meterError);
				return;
			}
			denied = false;
			const running: Acquisition = {
				kind: 'running',
				controller: attempt.controller,
				meter: opened,
				label: opened.microphone || 'System default',
			};
			acquisition = running;
			opened.onLevel((heard) => {
				if (acquisition === running) level = shown(heard);
			});
			// A microphone that stops on its own ends the test, said as a
			// refusal to open it would be.
			opened.onEnded((reason) => {
				if (acquisition !== running) return;
				release();
				report(endedError(reason, running.label));
			});
			// Access was just used, so names that were withheld can be listed now.
			void refresh();
		},
		release,
		/** A recording could not open the microphone: say whether access was the reason. */
		noteRecordingError(error: RecorderError) {
			if (error.name === 'PermissionDenied') denied = true;
		},
		/**
		 * Release the microphone and stop hearing about inputs. Nothing opens
		 * and no choice is accepted afterward. Saves already accepted go on
		 * by themselves; nothing waits for them.
		 */
		close() {
			closed = true;
			release();
			unwatch?.();
			unwatch = undefined;
		},
	};
}
