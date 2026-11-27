/**
 * The recorder in the desktop app: the native recorder plugin
 * (`tauri-plugin-epicenter-recorder`). It writes `recordings/<id>.webm` in
 * the app's local data directory a second at a time, so a crash keeps the
 * audio up to the cut.
 */
import {
	commands,
	type EndedReason,
	type ListenSignal,
	type RecordingSignal,
} from '@epicenter/recorder/native';
import { Channel } from '@tauri-apps/api/core';
import { appLocalDataDir } from '@tauri-apps/api/path';
import { Ok } from 'wellcrafted/result';
import type { Recorder } from './recorder';

/** A channel that hands each level the recorder sends to `onLevel`, and anything else to `onOther`. */
function levelChannel(
	onLevel: (level: number) => void,
	onOther: (
		signal: Extract<RecordingSignal, { kind: 'ended' }>,
	) => void = () => {},
) {
	const channel = new Channel<RecordingSignal>();
	channel.onmessage = (signal) => {
		if (signal.kind === 'level') onLevel(signal.level ?? 0);
		else onOther(signal);
	};
	return channel;
}

export const nativeRecorder: Recorder = {
	/**
	 * Start recording `id` from `device`. `onLevel` hears its level, from 0 to
	 * 1, about twenty times a second while it captures. `onEnded` hears a
	 * capture that ends on its own (a microphone unplugged); what was captured
	 * is still there for `stop` to finish.
	 */
	async start(
		id: string,
		{
			device,
			onEnded,
			onLevel,
		}: {
			device: string | null;
			onEnded: (reason: EndedReason) => void;
			onLevel: (level: number) => void;
		},
	) {
		const signals = levelChannel(onLevel, (signal) => onEnded(signal.reason));
		return commands.start(await appLocalDataDir(), id, device, signals);
	},

	/** Finish the recording in place; answers its id and length. */
	stop: () => commands.stop(),

	/** The microphones connected now. Opens nothing. */
	inputs: () => commands.inputs(),

	/**
	 * Open `device` to hear its level on `onLevel`, recording nothing.
	 * Answers the function that closes it.
	 */
	async listen(device: string | null, onLevel: (level: number) => void) {
		const opened = await commands.openMeter(device, levelChannel(onLevel));
		if (opened.error) return opened;
		const { id } = opened.data;
		return {
			data: () => void commands.closeMeter(id).catch(() => {}),
			error: null,
		};
	},

	/**
	 * Hands-free, in the recorder plugin (`listen.rs`). The plugin says a
	 * phrase started; this names its take at once, and tells `onSpeech`
	 * only when the name was taken. A name that is refused loses that one
	 * phrase and nothing else: the plugin drops it and keeps listening.
	 */
	handsFree: {
		async start({ device, id, onLevel, onSpeech, onPhrase, onEnded }) {
			const folder = await appLocalDataDir();
			const signals = new Channel<ListenSignal>();
			signals.onmessage = (signal) => {
				if (signal.kind === 'level') return onLevel(signal.level ?? 0);
				if (signal.kind === 'phrase') return onPhrase(signal.recording);
				if (signal.kind === 'ended') return onEnded(signal.reason);
				const phrase = id();
				void commands.namePhrase(folder, phrase).then((named) => {
					if (!named.error) onSpeech(phrase);
				});
			};
			return commands.listen(device, signals);
		},

		async stop() {
			const stopped = await commands.unlisten();
			// Not listening is already stopped: a microphone that ended on
			// its own and a second Stop both arrive here.
			if (stopped.error?.name === 'NotRecording') return Ok(null);
			return stopped;
		},
	},
};
