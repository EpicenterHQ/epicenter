/**
 * The recorder in a browser: `MediaRecorder` over `getUserMedia`.
 *
 * A take is kept in memory a second at a time and written whole on Stop,
 * through `files`, so a crash or a closed tab loses it; keeping a take
 * through that is the desktop app's. Its length is the time it ran.
 *
 * AAC in MP4 (`.m4a`) is asked for first, since native players open it,
 * then Opus in WebM (`.webm`). The extension is read from what the recorder
 * reports, not from what was asked: engines differ in what they honor.
 *
 * The microphone is opened without the browser's voice processing: Safari's
 * takes about two seconds to start and drops them from every take. A chosen
 * microphone is asked for by its exact id, so an unplugged one is refused
 * rather than swapped for another.
 */
import { Err, Ok } from 'wellcrafted/result';
import type { Files } from '../files/files';
import type { EndedReason, Recorder, RecorderError } from './recorder';

/** What `MediaRecorder` is asked for, in order. */
const TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/webm;codecs=opus'];
/** How often the level is read. */
const LEVEL_EVERY_MS = 50;
/** How much audio each piece `MediaRecorder` hands over holds. */
const PIECE_MS = 1000;

const UNPROCESSED = {
	echoCancellation: false,
	noiseSuppression: false,
	autoGainControl: false,
} satisfies MediaTrackConstraints;

const refuse = (name: RecorderError['name'], message: string) =>
	Err({ name, message } as RecorderError);

/** `m4a` for any MP4, however the engine spells it; otherwise `webm`. */
function extensionOf(type: string) {
	const container = type.split(';')[0]?.trim().toLowerCase();
	return container === 'audio/mp4' || container === 'video/mp4'
		? 'm4a'
		: 'webm';
}

/** Stop every track, which releases the microphone. */
const release = (stream: MediaStream) => {
	for (const track of stream.getTracks()) track.stop();
};

/** Open exactly `device`, or the system default when it is null. */
async function open(device: string | null) {
	if (!navigator.mediaDevices?.getUserMedia)
		return refuse(
			'NoInputDevice',
			'This browser window has no microphone access.',
		);
	try {
		return Ok(
			await navigator.mediaDevices.getUserMedia({
				audio: device
					? { ...UNPROCESSED, deviceId: { exact: device } }
					: UNPROCESSED,
			}),
		);
	} catch (cause) {
		const name = cause instanceof Error ? cause.name : '';
		if (name === 'NotAllowedError' || name === 'SecurityError')
			return refuse(
				'PermissionDenied',
				'Microphone access is blocked for this page.',
			);
		if (device && (name === 'OverconstrainedError' || name === 'NotFoundError'))
			return refuse(
				'InputUnavailable',
				'The chosen microphone is not connected.',
			);
		if (name === 'NotFoundError')
			return refuse('NoInputDevice', 'No microphone was found.');
		if (name === 'NotReadableError')
			return refuse('Busy', 'Another app is using the microphone.');
		return refuse(
			'Failed',
			`The microphone could not be opened: ${String(cause)}`,
		);
	}
}

/** Read `stream`'s level into `onLevel` until the returned function is called. Nothing is played. */
function meter(stream: MediaStream, onLevel: (level: number) => void) {
	const context = new AudioContext();
	const source = context.createMediaStreamSource(stream);
	const analyser = context.createAnalyser();
	analyser.fftSize = 1024;
	source.connect(analyser);
	void context.resume().catch(() => {});
	const samples = new Float32Array(analyser.fftSize);
	const timer = setInterval(() => {
		analyser.getFloatTimeDomainData(samples);
		let squares = 0;
		for (const sample of samples) squares += sample * sample;
		onLevel(Math.min(1, Math.sqrt(squares / samples.length)));
	}, LEVEL_EVERY_MS);
	return () => {
		clearInterval(timer);
		source.disconnect();
		void context.close().catch(() => {});
	};
}

export function createBrowserRecorder(files: Files): Recorder {
	/** The take under way. */
	let take:
		| {
				id: string;
				stream: MediaStream;
				recorder: MediaRecorder;
				pieces: Blob[];
				startedAt: number;
				stopMeter: () => void;
		  }
		| undefined;

	return {
		async start(id, { device, onEnded, onLevel }) {
			if (take) return refuse('Busy', 'A recording is already running.');
			const type =
				typeof MediaRecorder === 'undefined'
					? undefined
					: TYPES.find((type) => MediaRecorder.isTypeSupported(type));
			if (!type)
				return refuse(
					'Failed',
					'This browser cannot record audio as MP4 or WebM.',
				);
			const opened = await open(device);
			if (opened.error) return opened;
			const stream = opened.data;
			const pieces: Blob[] = [];
			let recorder: MediaRecorder;
			try {
				recorder = new MediaRecorder(stream, { mimeType: type });
				recorder.addEventListener('dataavailable', ({ data }) => {
					if (data.size > 0) pieces.push(data);
				});
				recorder.start(PIECE_MS);
			} catch (cause) {
				release(stream);
				return refuse(
					'Failed',
					`The recording could not start: ${String(cause)}`,
				);
			}
			const ended = (reason: EndedReason) => () => {
				if (take?.id === id) onEnded(reason);
			};
			for (const track of stream.getAudioTracks())
				track.addEventListener('ended', ended('deviceDisconnected'));
			recorder.addEventListener('error', ended('streamFailed'));
			take = {
				id,
				stream,
				recorder,
				pieces,
				startedAt: performance.now(),
				stopMeter: meter(stream, onLevel),
			};
			return Ok(null);
		},

		async stop() {
			if (!take) return refuse('NotRecording', 'No recording is running.');
			const { id, stream, recorder, pieces, startedAt, stopMeter } = take;
			take = undefined;
			const durationMs = Math.round(performance.now() - startedAt);
			// The last piece arrives before `stop`.
			if (recorder.state !== 'inactive')
				await new Promise((resolve) => {
					recorder.addEventListener('stop', resolve, { once: true });
					recorder.stop();
				});
			stopMeter();
			release(stream);
			const blob = new Blob(pieces, { type: recorder.mimeType });
			const path = `recordings/${id}.${extensionOf(recorder.mimeType)}`;
			const written = await files.write(
				path,
				new Uint8Array(await blob.arrayBuffer()),
			);
			if (written.error)
				return refuse(
					'Failed',
					`The recording could not be saved: ${written.error.message}`,
				);
			return Ok({ id, durationMs });
		},

		async inputs() {
			if (!navigator.mediaDevices?.enumerateDevices) return Ok([]);
			const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
				(device) => device.kind === 'audioinput',
			);
			// Chrome lists the default as an extra entry that shares a real microphone's group.
			const fallback = devices.find((device) => device.deviceId === 'default');
			return Ok(
				devices
					.filter(
						({ deviceId }) =>
							deviceId &&
							deviceId !== 'default' &&
							deviceId !== 'communications',
					)
					.map((device, index) => ({
						id: device.deviceId,
						// Names show only once the page may use the microphone.
						name: device.label || `Microphone ${index + 1}`,
						isDefault: fallback
							? device.groupId === fallback.groupId
							: index === 0,
					})),
			);
		},

		async listen(device, onLevel) {
			const opened = await open(device);
			if (opened.error) return opened;
			const stopMeter = meter(opened.data, onLevel);
			return Ok(() => {
				stopMeter();
				release(opened.data);
			});
		},
	};
}
