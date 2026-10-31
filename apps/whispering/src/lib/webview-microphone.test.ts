/**
 * WebView microphone tests
 *
 * Drives the browser's microphone device over a scripted WebView: `getUserMedia`,
 * `enumerateDevices`, a recorder, and an audio graph that count what was
 * opened and released. Recording goes through `@epicenter/recorder`'s browser
 * recorder over the same WebView. No hardware is involved, so these establish
 * what the app asks the WebView for and what it releases, not how a
 * microphone behaves.
 *
 * Key behaviors:
 * - A chosen microphone is asked for by its exact ID; the system default is
 *   asked for only when nothing is chosen
 * - A chosen microphone that cannot be opened refuses, with one request and
 *   no second microphone opened in its place
 * - A stream that is not the chosen microphone is released and refused
 * - Access refusals and a missing microphone are reported as themselves
 * - Listing never opens a microphone and names nothing the WebView withheld
 * - Enabling opens the default microphone and releases it at once
 * - A test's stream and audio graph are released when it stops, and a stream
 *   that arrives after the request was withdrawn is released
 */
import { expect, test } from 'bun:test';
import type { Client } from '@epicenter/definition/contract';
import {
	type BrowserEnvironment,
	createBrowserRecorder,
} from '@epicenter/recorder/browser';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import type { CaptureDevice, CaptureStart } from './capture.js';
import type { Whispering } from './contract.js';
import { deferred } from './services.test-support.js';
import {
	createWebViewMicrophone,
	type MicrophoneEnvironment,
} from './webview-microphone.js';

const USB = { deviceId: 'usb-id', label: 'USB Microphone' };

/** A start with the system default. The scripted recorder hands over no audio, so nothing is written. */
const INTO: CaptureStart = { id: 'a' };

/** The store recordings go into; the recorder reaches it only through `filesOf`. */
const store = {} as Client<Whispering>;

/** The browser recorder over `environment`, as the page records in a browser, into an empty store. */
const recorderOver = (
	environment: Pick<BrowserEnvironment, 'mediaDevices' | 'Recorder'>,
) =>
	createBrowserRecorder({
		...environment,
		createLevelContext: undefined,
		now: () => 0,
		filesOf: () => ({
			list: async () => Ok([]),
			read: async () => Ok(null),
			write: async () => Ok('stale'),
			append: async () => Ok('landed'),
		}),
		locks: undefined,
	});

const named = (name: string) => Object.assign(new Error(name), { name });

/** The real inputs of a WebView microphone, which can always ask for access. */
function inputsOf(device: CaptureDevice) {
	const inputs = device.inputs;
	if (inputs?.allow === undefined)
		throw new Error('A WebView microphone has inputs it can allow');
	const allow = inputs.allow.bind(inputs);
	return { ...inputs, allow };
}

type FakeStream = { readonly deviceId: string; stopped: boolean };

/** A WebView that records every request and every stream it handed out. */
function webView({
	devices = [
		{
			kind: 'audioinput',
			deviceId: 'default',
			label: 'Default - Built-in Microphone',
		},
		{
			kind: 'audioinput',
			deviceId: 'built-in-id',
			label: 'Built-in Microphone',
		},
		{ kind: 'audioinput', deviceId: 'usb-id', label: 'USB Microphone' },
		{ kind: 'audiooutput', deviceId: 'speakers-id', label: 'Speakers' },
	],
	open = async (constraints: MediaStreamConstraints): Promise<string> => {
		const audio = constraints.audio;
		return typeof audio === 'object'
			? String((audio.deviceId as ConstrainDOMStringParameters).exact)
			: 'built-in-id';
	},
}: {
	devices?: { kind: string; deviceId: string; label: string }[];
	/** Answers a request with the ID of the microphone that opens, or throws. */
	open?: (constraints: MediaStreamConstraints) => Promise<string>;
} = {}) {
	const requests: MediaStreamConstraints[] = [];
	const streams: FakeStream[] = [];
	const tracks: EventTarget[] = [];
	const graphs: { closed: boolean; disconnected: boolean }[] = [];
	const changeListeners = new Set<() => void>();
	let listings = 0;
	const mediaDevices: MicrophoneEnvironment['mediaDevices'] = {
		async getUserMedia(constraints = {}) {
			requests.push(constraints);
			const stream: FakeStream = {
				deviceId: await open(constraints),
				stopped: false,
			};
			streams.push(stream);
			const track = Object.assign(new EventTarget(), {
				label:
					devices.find((device) => device.deviceId === stream.deviceId)
						?.label ?? '',
				stop: () => {
					stream.stopped = true;
				},
				getSettings: () => ({ deviceId: stream.deviceId }),
			});
			tracks.push(track);
			return {
				getTracks: () => [track],
				getAudioTracks: () => [track],
			} as unknown as MediaStream;
		},
		async enumerateDevices() {
			listings += 1;
			return devices as MediaDeviceInfo[];
		},
		addEventListener(_type, listener) {
			changeListeners.add(listener);
		},
		removeEventListener(_type, listener) {
			changeListeners.delete(listener);
		},
	};
	const environment: MicrophoneEnvironment = {
		mediaDevices,
		recorder: recorderOver({
			mediaDevices,
			Recorder: class extends EventTarget {
				static isTypeSupported = () => false;
				mimeType = 'audio/webm';
				start() {}
				stop() {
					this.dispatchEvent(new Event('stop'));
				}
			} as unknown as BrowserEnvironment['Recorder'],
		}),
		createLevelContext() {
			const graph = { closed: false, disconnected: false };
			graphs.push(graph);
			return {
				createMediaStreamSource: () => ({
					connect: () => {},
					disconnect: () => {
						graph.disconnected = true;
					},
				}),
				createAnalyser: () => ({
					fftSize: 0,
					getFloatTimeDomainData: (samples) => samples.fill(0.25),
				}),
				resume: async () => {},
				close: async () => {
					graph.closed = true;
				},
			};
		},
	};
	return {
		environment,
		requests,
		streams,
		tracks,
		graphs,
		changeListeners,
		get listings() {
			return listings;
		},
	};
}

test('a chosen microphone is asked for by its exact ID, and the system default only when none is chosen', async () => {
	const view = webView();
	const device = createWebViewMicrophone(store, view.environment);

	await expectOk(await device.start({ ...INTO, input: USB })).stop();
	await expectOk(await device.start(INTO)).stop();

	expect(view.requests).toEqual([
		{ audio: { deviceId: { exact: 'usb-id' } } },
		{ audio: true },
	]);
	expect(view.streams.map((stream) => stream.stopped)).toEqual([true, true]);
});

test('a chosen microphone that is not there refuses after one request, and no other is opened', async () => {
	for (const refusal of ['OverconstrainedError', 'NotFoundError']) {
		const view = webView({
			open: async () => {
				throw named(refusal);
			},
		});
		const device = createWebViewMicrophone(store, view.environment);

		const error = expectErr(await device.start({ ...INTO, input: USB }));

		expect(error.name).toBe('InputUnavailable');
		expect(error.message).toContain('USB Microphone');
		expect(view.requests).toEqual([
			{ audio: { deviceId: { exact: 'usb-id' } } },
		]);
		expect(view.streams).toEqual([]);
	}
});

test('a stream that is not the chosen microphone is released and refused', async () => {
	// A WebView that answers an exact request with some other input.
	const view = webView({ open: async () => 'built-in-id' });
	const device = createWebViewMicrophone(store, view.environment);

	expect(expectErr(await device.start({ ...INTO, input: USB })).name).toBe(
		'InputUnavailable',
	);
	expect(expectErr(await inputsOf(device).meter(USB)).name).toBe(
		'InputUnavailable',
	);

	expect(view.streams).toEqual([
		{ deviceId: 'built-in-id', stopped: true },
		{ deviceId: 'built-in-id', stopped: true },
	]);
});

test('refused access and a missing default microphone are reported as themselves', async () => {
	for (const [thrown, expected] of [
		['NotAllowedError', 'PermissionDenied'],
		['SecurityError', 'PermissionDenied'],
		['NotFoundError', 'Unavailable'],
		['NotReadableError', 'Failed'],
	] as const) {
		const view = webView({
			open: async () => {
				throw named(thrown);
			},
		});
		const device = createWebViewMicrophone(store, view.environment);
		const inputs = inputsOf(device);

		expect(expectErr(await device.start(INTO)).name).toBe(expected);
		expect(expectErr(await inputs.allow()).name).toBe(expected);
		expect(expectErr(await inputs.meter(undefined)).name).toBe(expected);
		expect(view.graphs).toEqual([]);
	}
});

test('a window with no microphone access says so for recording, listing, enabling, and testing', async () => {
	const device = createWebViewMicrophone(store, {
		mediaDevices: undefined,
		createLevelContext: undefined,
		recorder: recorderOver({ mediaDevices: undefined, Recorder: undefined }),
	});
	const inputs = inputsOf(device);

	expect(expectErr(await device.start(INTO)).name).toBe('Unavailable');
	expect(expectErr(await inputs.list()).name).toBe('Unavailable');
	expect(expectErr(await inputs.allow()).name).toBe('Unavailable');
	expect(expectErr(await inputs.meter(undefined)).name).toBe('Unavailable');
	// Nothing to hear about, and nothing to undo.
	inputs.onChange(() => {})();
});

test('listing opens no microphone, lists audio inputs by name, and leaves out the system aliases', async () => {
	const view = webView();
	const inputs = inputsOf(createWebViewMicrophone(store, view.environment));

	expect(expectOk(await inputs.list())).toEqual({
		devices: [{ deviceId: 'built-in-id', label: 'Built-in Microphone' }, USB],
		namesWithheld: false,
	});
	expect(view.requests).toEqual([]);
});

test('before access is allowed, withheld names are reported and nothing is listed by name', async () => {
	const withheld = webView({
		devices: [{ kind: 'audioinput', deviceId: '', label: '' }],
	});
	const none = webView({
		devices: [
			{ kind: 'audiooutput', deviceId: 'speakers-id', label: 'Speakers' },
		],
	});

	expect(
		expectOk(
			await inputsOf(
				createWebViewMicrophone(store, withheld.environment),
			).list(),
		),
	).toEqual({
		devices: [],
		namesWithheld: true,
	});
	expect(
		expectOk(
			await inputsOf(createWebViewMicrophone(store, none.environment)).list(),
		),
	).toEqual({
		devices: [],
		namesWithheld: false,
	});
	expect([...withheld.requests, ...none.requests]).toEqual([]);
});

test('enabling opens the default microphone once and releases it at once', async () => {
	const view = webView();
	const inputs = inputsOf(createWebViewMicrophone(store, view.environment));

	expectOk(await inputs.allow());

	expect(view.requests).toEqual([{ audio: true }]);
	expect(view.streams).toEqual([{ deviceId: 'built-in-id', stopped: true }]);
});

test('a test reads a level from the chosen microphone and releases the stream and audio graph when stopped', async () => {
	const view = webView();
	const inputs = inputsOf(createWebViewMicrophone(store, view.environment));

	const meter = expectOk(await inputs.meter(USB));

	expect(view.requests).toEqual([{ audio: { deviceId: { exact: 'usb-id' } } }]);
	expect(meter.label).toBe('USB Microphone');
	expect(meter.level()).toBeGreaterThan(0);
	expect(meter.level()).toBeLessThanOrEqual(1);
	expect(view.streams[0]!.stopped).toBe(false);

	meter.stop();
	meter.stop();

	expect(view.streams).toEqual([{ deviceId: 'usb-id', stopped: true }]);
	expect(view.graphs).toEqual([{ closed: true, disconnected: true }]);
	expect(meter.level()).toBe(0);
});

test('a microphone that opens after its request was withdrawn is released, for a test and for a recording', async () => {
	for (const request of ['meter', 'start', 'allow'] as const) {
		const answer = deferred<string>();
		const view = webView({ open: () => answer.promise });
		const device = createWebViewMicrophone(store, view.environment);
		const inputs = inputsOf(device);
		const withdrawn = new AbortController();

		const pending =
			request === 'meter'
				? inputs.meter(USB, withdrawn.signal)
				: request === 'allow'
					? inputs.allow(withdrawn.signal)
					: device.start({ ...INTO, input: USB, signal: withdrawn.signal });
		// Withdrawn once the WebView was asked (a recording first checks the store).
		for (let turn = 0; view.requests.length === 0 && turn < 100; turn++)
			await Promise.resolve();
		withdrawn.abort();
		answer.resolve('usb-id');

		expect(expectErr(await pending).name).toBe('Cancelled');
		expect(view.streams).toEqual([{ deviceId: 'usb-id', stopped: true }]);
		expect(view.graphs).toEqual([]);
	}
});

test('a request withdrawn before it is made opens nothing', async () => {
	const view = webView();
	const device = createWebViewMicrophone(store, view.environment);
	const withdrawn = new AbortController();
	withdrawn.abort();

	expect(
		expectErr(await device.start({ ...INTO, signal: withdrawn.signal })).name,
	).toBe('Cancelled');
	expect(view.requests).toEqual([]);
});

test('connected and removed inputs are heard until the listener is removed', async () => {
	const view = webView();
	const inputs = inputsOf(createWebViewMicrophone(store, view.environment));
	let heard = 0;

	const stop = inputs.onChange(() => (heard += 1));
	for (const listener of view.changeListeners) listener();
	stop();

	expect(heard).toBe(1);
	expect(view.changeListeners.size).toBe(0);
});

test('a browser meter ending before subscription remains available until it is released', async () => {
	const view = webView();
	const meter = expectOk(
		await inputsOf(createWebViewMicrophone(store, view.environment)).meter(USB),
	);
	try {
		view.tracks[0]!.dispatchEvent(new Event('ended'));
		const heard: string[] = [];
		meter.onEnded((error) => {
			heard.push(error.name);
			meter.stop();
		});
		expect(heard).toEqual(['InputUnavailable']);
		expect(view.streams[0]?.stopped).toBe(true);
		expect(view.graphs[0]?.closed).toBe(true);
		const late: string[] = [];
		meter.onEnded((error) => late.push(error.name));
		expect(late).toEqual([]);
	} finally {
		meter.stop();
	}
});

test('a browser meter ending reaches every listener when the first releases it', async () => {
	const view = webView();
	const meter = expectOk(
		await inputsOf(createWebViewMicrophone(store, view.environment)).meter(USB),
	);
	try {
		const heard: string[] = [];
		meter.onEnded(() => meter.stop());
		meter.onEnded((error) => heard.push(error.name));
		view.tracks[0]!.dispatchEvent(new Event('ended'));
		expect(heard).toEqual(['InputUnavailable']);
	} finally {
		meter.stop();
	}
});
