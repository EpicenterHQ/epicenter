/**
 * The microphone a session records from, and the test of it.
 *
 * The choice is the system default or one microphone, identified by the ID
 * its platform lists it under: the shell's in Epicenter, the WebView's in a
 * browser. It is kept on this device through the workspace and
 * applies to the next recording: a recording that is running keeps the
 * microphone it opened, so the choice cannot be changed while one is
 * starting, running, or finishing. A choice whose ID is not listed stays the
 * choice. A name is not an identity, so no listed input is taken for it; the
 * person chooses again. The choice applies at once; saving it on the device
 * follows, one save at a time in the order chosen.
 *
 * Nothing here asks for microphone access on its own. Listing reads what the
 * platform already lists; `allow` and `startTest` are the actions that open a
 * microphone, and each is something the person pressed.
 *
 * Those two are the only things here that open a microphone, and they share
 * one owner: at most one of them is under way, never beside a recording, and
 * `release` ends whichever it is. A microphone that opens after the
 * release is released when it arrives. A test reads a level and nothing
 * else: no audio is recorded, sent, or saved.
 */
import type {
	CaptureDevice,
	CaptureError,
	MicrophoneMeter,
	MicrophonePreference,
} from './capture.js';
import type { Workspace } from './workspace/index.js';

export type MicrophoneInput = ReturnType<typeof createMicrophoneInput>;

/** What is known of the inputs the platform lists. */
export type InputList =
	/** Nothing has been listed yet. */
	| { readonly kind: 'unread' }
	| { readonly kind: 'unsupported'; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			readonly kind: 'listed';
			readonly devices: readonly MicrophonePreference[];
			/**
			 * Inputs exist, but they are not named until access is allowed.
			 * Absent where names are never withheld, as in Epicenter.
			 */
			readonly namesWithheld?: boolean;
	  };

export type InputTest =
	| { readonly phase: 'idle' }
	| { readonly phase: 'opening' }
	| { readonly phase: 'running'; readonly label: string };

/** How often the level is read while a test runs. */
const LEVEL_MS = 80;

const RECORDING =
	'A recording is using the microphone. Stop it before changing or testing the input.';

export function createMicrophoneInput({
	capture,
	preferences,
	recording,
}: {
	capture: CaptureDevice;
	preferences: Workspace['preferences'];
	/** Whether a recording is starting, running, or finishing. */
	recording: () => boolean;
}) {
	const inputs = capture.inputs;
	let choice = $state.raw<MicrophonePreference | undefined>();
	let list = $state.raw<InputList>({ kind: 'unread' });
	let listing = $state(false);
	let allowing = $state(false);
	let test = $state.raw<InputTest>({ phase: 'idle' });
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
	let acquiring: AbortController | undefined;
	let meter: MicrophoneMeter | undefined;
	let levelTimer: ReturnType<typeof setInterval> | undefined;

	function report(error: CaptureError | null) {
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
	function persist(next: MicrophonePreference | undefined): Promise<void> {
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
		if (inputs === undefined || closed) return;
		// Told about connected and removed inputs from the first listing on.
		unwatch ??= inputs.onChange(() => void refresh());
		const sequence = ++listSequence;
		listing = true;
		const { data: listed, error: listError } = await inputs.list();
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
		// whatever an earlier attempt said. Epicenter names inputs without
		// access, so there only a microphone that opens clears a denial.
		if (listed.namesWithheld !== undefined && listed.devices.length > 0)
			denied = false;
	}

	/**
	 * End whatever is opening or holding a microphone here: a pending enable,
	 * or a test that is opening or running. Safe to call when nothing is.
	 */
	function release() {
		acquiring?.abort();
		acquiring = undefined;
		clearInterval(levelTimer);
		levelTimer = undefined;
		meter?.stop();
		meter = undefined;
		level = 0;
		allowing = false;
		test = { phase: 'idle' };
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
		return acquiring === undefined;
	}

	return {
		/** False in fixture mode: there is no real input to choose, list, or test. */
		available: inputs !== undefined,
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
			return allowing;
		},
		/** Whether access can be asked for here: a WebView's, never Epicenter's, which asks itself. */
		canAllow: inputs?.allow !== undefined,
		/** Whether the system's microphone privacy settings can be opened from here. */
		canOpenSettings: inputs?.openSettings !== undefined,
		/**
		 * Whether the chosen microphone's ID is among those listed. Undefined
		 * while that cannot be told: nothing is listed by name yet, which is also
		 * what a WebView shows before access is allowed. An input with the same
		 * name under another ID is not the chosen one.
		 */
		get choiceListed(): boolean | undefined {
			const chosen = choice;
			if (chosen === undefined || list.kind !== 'listed') return undefined;
			if (list.devices.length === 0) return undefined;
			return list.devices.some((device) => device.deviceId === chosen.deviceId);
		},
		get test() {
			return test;
		},
		/** The level of the running test, from 0 to 1. */
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
		async load() {
			if (inputs === undefined) return;
			try {
				choice = await preferences.microphone();
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
			const allow = inputs?.allow;
			if (allow === undefined || closed || !mayOpen()) return;
			problem = undefined;
			const attempt = new AbortController();
			acquiring = attempt;
			allowing = true;
			const { error: allowError } = await allow.call(inputs, attempt.signal);
			// Released while the platform was answering. Whatever it opened is not kept.
			if (acquiring !== attempt) return;
			release();
			report(allowError);
			await refresh();
		},
		/**
		 * Choose the microphone the next recording uses, or undefined for the
		 * system default. A test under way is of the previous choice, so it ends.
		 */
		async select(next: MicrophonePreference | undefined) {
			if (inputs === undefined || closed) return;
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
			if (inputs === undefined || closed || !mayOpen()) return;
			problem = undefined;
			const attempt = new AbortController();
			acquiring = attempt;
			test = { phase: 'opening' };
			const { data: opened, error: meterError } = await inputs.meter(
				choice,
				attempt.signal,
			);
			// Released, or released and started again, while the platform was answering.
			if (acquiring !== attempt) {
				if (meterError === null) opened.stop();
				return;
			}
			if (meterError !== null) {
				release();
				report(meterError);
				return;
			}
			denied = false;
			meter = opened;
			test = { phase: 'running', label: opened.label };
			// A microphone that stops on its own ends the test, said as a
			// recording's ending is.
			opened.onEnded((error) => {
				if (meter !== opened) return;
				release();
				report(error);
			});
			levelTimer = setInterval(() => {
				level = meter?.level() ?? 0;
			}, LEVEL_MS);
			// Access was just used, so names that were withheld can be listed now.
			void refresh();
		},
		release,
		/** Open the system's microphone privacy settings, where a denial is undone. */
		async openSettings() {
			const openSettings = inputs?.openSettings;
			if (openSettings === undefined || closed) return;
			const { error } = await openSettings.call(inputs);
			if (error !== null) problem = error.message;
		},
		/** A recording could not open the microphone: say whether access was the reason. */
		noteRecordingError(error: CaptureError) {
			if (error.name === 'PermissionDenied') denied = true;
		},
		/**
		 * Release the microphone and stop hearing about inputs. Nothing opens
		 * and no choice is accepted afterward. Saves already accepted go on:
		 * `saved` says when they have ended.
		 */
		close() {
			closed = true;
			release();
			unwatch?.();
			unwatch = undefined;
		},
		/** Settles when every save of the choice accepted so far has answered. */
		saved(): Promise<void> {
			return saves;
		},
	};
}
