import { expect, mock, test } from 'bun:test';
import { InstantString } from '@epicenter/app/field';
import { openMemory } from '@epicenter/app/memory';
import { generateBlobId } from '@epicenter/blobs';
import { CAPTURE_PROMOTION_CHANNEL, captureDefinition, createPromotedCapture,
	PromotionInspectionRequired, type CapturePromotionMessage } from '@epicenter/capture';
import { whisperingDefinition } from '../data.js';
import type { WhisperingApp, WhisperingData } from '../whispering/app.js';

let windowOperation: (_reveal: boolean) => Promise<void> = async () => { throw new Error('Host unavailable'); };
mock.module('#platform/capture-window', () => ({
	setCaptureWindowVisible: (reveal: boolean) => windowOperation(reveal),
}));
const { addToCapture, openInCapture, PromotedCaptureUnavailable } = await import('./capture-promotion.js');

test('a failed launch retries the saved request and Capture creates one root', async () => {
	await using whispering = await openMemory(whisperingDefinition);
	await using capture = await openMemory(captureDefinition);
	const recording = whispering.tables.recordings.create({
		audioBlobId: generateBlobId('wav'), title: '',
		recordedAt: InstantString.fromDate(new Date('2026-09-01T10:00:00Z')),
		recordedAtZone: 'UTC', duration: null,
	});
	const account = { authorityId: 'test-server', principalId: 'alice' };
	const app = { signal: new AbortController().signal, authAccount: account } as WhisperingApp;
	await expect(addToCapture(app, whispering as WhisperingData, recording, 'result-1', 'Chosen text'))
		.rejects.toThrow('Host unavailable');
	const requestId = whispering.tables.capturePromotions.rows[0]?.requestId;
	expect(requestId).toBeTruthy();

	const receiver = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
	receiver.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
		const message = event.data;
		if (message.type !== 'add') return;
		const captureId = createPromotedCapture(capture, message);
		receiver.postMessage({ type: 'added', requestId: message.requestId,
			account: message.account, captureId } satisfies CapturePromotionMessage);
	};
	try {
		windowOperation = async () => {};
		const captureId = await addToCapture(app, whispering as WhisperingData,
			recording, 'result-1', 'Chosen text');
		expect(capture.tables.captures.rows.map((row) => row.id)).toEqual([captureId]);
		expect(capture.tables.captures.body(captureId)?.toString()).toBe('Chosen text');
		expect(capture.tables.captures.get(captureId)?.capturedAt).toBe(recording.recordedAt);
		expect(whispering.tables.capturePromotions.rows).toHaveLength(1);
		expect(whispering.tables.capturePromotions.rows[0]?.requestId).toBe(requestId);
		expect(await addToCapture(app, whispering as WhisperingData,
			recording, 'result-1', 'Chosen text')).toBe(captureId);
	} finally {
		receiver.close();
		windowOperation = async () => { throw new Error('Host unavailable'); };
	}
});

test('Open waits for a Capture listener that mounts after the window exists', async () => {
	windowOperation = async () => {};
	const app = { signal: new AbortController().signal,
		authAccount: { authorityId: 'test-server', principalId: 'alice' } } as WhisperingApp;
	let receiver: BroadcastChannel | undefined;
	let received = 0;
	const mount = setTimeout(() => {
		receiver = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
		receiver.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
			if (event.data.type !== 'open') return;
			received++;
			receiver?.postMessage({ ...event.data, type: 'opened' } satisfies CapturePromotionMessage);
		};
	}, 100);
	try {
		await openInCapture(app, 'capture-1');
		expect(received).toBeGreaterThan(0);
	} finally {
		clearTimeout(mount);
		receiver?.close();
		windowOperation = async () => { throw new Error('Host unavailable'); };
	}
});

test('sign-out during native preparation sends no promotion request', async () => {
	await using whispering = await openMemory(whisperingDefinition);
	const recording = whispering.tables.recordings.create({
		audioBlobId: generateBlobId('wav'), title: '', recordedAt: InstantString.now(),
		recordedAtZone: 'UTC', duration: null,
	});
	const controller = new AbortController();
	const app = { signal: controller.signal,
		authAccount: { authorityId: 'test-server', principalId: 'alice' } } as WhisperingApp;
	let release: (() => void) | undefined;
	windowOperation = () => new Promise<void>((resolve) => { release = resolve; });
	const receiver = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
	let received = 0;
	receiver.onmessage = () => { received++; };
	try {
		const pending = addToCapture(app, whispering as WhisperingData,
			recording, 'result-1', 'Chosen text');
		while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		release();
		await expect(pending).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(received).toBe(0);
	} finally {
		receiver.close();
		windowOperation = async () => { throw new Error('Host unavailable'); };
	}
});

test('an ambiguous Capture claim stops retransmission and requires inspection', async () => {
	await using whispering = await openMemory(whisperingDefinition);
	const recording = whispering.tables.recordings.create({
		audioBlobId: generateBlobId('wav'), title: '', recordedAt: InstantString.now(),
		recordedAtZone: 'UTC', duration: null,
	});
	const app = { signal: new AbortController().signal,
		authAccount: { authorityId: 'test-server', principalId: 'alice' } } as WhisperingApp;
	windowOperation = async () => {};
	const receiver = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
	receiver.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
		if (event.data.type !== 'add') return;
		receiver.postMessage({ type: 'inspection-required', requestId: event.data.requestId,
			account: event.data.account, captureId: null } satisfies CapturePromotionMessage);
	};
	try {
		await expect(addToCapture(app, whispering as WhisperingData,
			recording, 'result-1', 'Chosen text')).rejects.toBeInstanceOf(PromotionInspectionRequired);
		expect(whispering.tables.capturePromotions.rows).toHaveLength(1);
	} finally {
		receiver.close();
		windowOperation = async () => { throw new Error('Host unavailable'); };
	}
});

test('Open reports a deleted Capture destination', async () => {
	windowOperation = async () => {};
	const app = { signal: new AbortController().signal,
		authAccount: { authorityId: 'test-server', principalId: 'alice' } } as WhisperingApp;
	const receiver = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
	receiver.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
		if (event.data.type !== 'open') return;
		receiver.postMessage({ type: 'unavailable', requestId: event.data.requestId,
			account: event.data.account, captureId: event.data.captureId } satisfies CapturePromotionMessage);
	};
	try {
		await expect(openInCapture(app, 'deleted')).rejects.toBeInstanceOf(PromotedCaptureUnavailable);
	} finally {
		receiver.close();
		windowOperation = async () => { throw new Error('Host unavailable'); };
	}
});
