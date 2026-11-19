/**
 * The native recorder (`tauri-plugin-epicenter-recorder`). It writes
 * `recordings/<id>.webm` in the app's local data directory a second at a
 * time, so a crash keeps the audio up to the cut. It also lists the
 * microphones and opens a meter on one, for choosing one in settings.
 *
 * A microphone is named by the id `inputs` lists it under; `null` is the
 * system default. A microphone that is not connected is refused, never
 * swapped for another.
 */
import {
	commands,
	type EndedReason,
	type RecordingSignal,
} from '@epicenter/recorder/native';
import { Channel } from '@tauri-apps/api/core';
import { appLocalDataDir } from '@tauri-apps/api/path';

export type { EndedReason, Input } from '@epicenter/recorder/native';

/**
 * A level above this is sound. A microphone that sends nothing louder (a
 * muted one, or one that sends digital silence, about -91 dB) is worth
 * pointing out.
 */
export const HEARD = 0.0005;

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

export const recorder = {
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
};
