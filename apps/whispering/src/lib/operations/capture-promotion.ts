import { CAPTURE_PROMOTION_CHANNEL, PromotionInspectionRequired,
	type CapturePromotionMessage } from '@epicenter/capture';
import { setCaptureWindowVisible } from '#platform/capture-window';
import type { CapturePromotion, Recording } from '../data.js';
import type { WhisperingApp, WhisperingData } from '../whispering/app.js';

export function promotionFor(
	store: WhisperingData,
	resultId: string,
	text: string,
	account: { authorityId: string; principalId: string },
): CapturePromotion | undefined {
	return store.tables.capturePromotions.rows.find((row) =>
		row.resultId === resultId && row.text === text &&
		row.authorityId === account.authorityId &&
		row.principalId === account.principalId,
	);
}

export class PromotedCaptureUnavailable extends Error {
	constructor() {
		super('This capture is no longer available in Capture.');
		this.name = 'PromotedCaptureUnavailable';
	}
}

/** Freeze text, date, and Account in Local before sending to Capture's owner. */
export async function addToCapture(
	app: WhisperingApp,
	store: WhisperingData,
	recording: Recording,
	resultId: string,
	text: string,
): Promise<string> {
	const account = app.authAccount;
	if (!account || app.signal.aborted) throw new Error('Sign in to add text to Capture.');
	if (!text.trim()) throw new Error('Choose a transcription with text.');
	let receipt = promotionFor(store, resultId, text, account);
	if (receipt?.captureId) return receipt.captureId;
	if (!receipt) {
		receipt = store.tables.capturePromotions.create({
			resultId,
			requestId: crypto.randomUUID(),
			authorityId: account.authorityId,
			principalId: account.principalId,
			text,
			capturedAt: recording.recordedAt,
			captureId: null,
		});
	}
	await store.persistence.flush();
	if (store.persistence.get() !== 'saved')
		throw new Error('The request is not saved locally yet. Finish saving before retrying.');
	app.signal.throwIfAborted();

	const request = {
		type: 'add',
		requestId: receipt.requestId,
		account: { authorityId: receipt.authorityId, principalId: receipt.principalId },
		text: receipt.text,
		capturedAt: receipt.capturedAt,
	} as const;
	const channel = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
	let interval: ReturnType<typeof setInterval> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await setCaptureWindowVisible(false);
		app.signal.throwIfAborted();
		const acknowledged = new Promise<string>((resolve, reject) => {
			onAbort = () => reject(new Error('The account changed.'));
			app.signal.addEventListener('abort', onAbort, { once: true });
			timeout = setTimeout(() =>
				reject(new Error('Capture did not confirm this request. Retry sends the same saved request.')),
				20_000);
			channel.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
				const message = event.data;
				if (!message || message.requestId !== request.requestId ||
					message.account.authorityId !== request.account.authorityId ||
					message.account.principalId !== request.account.principalId) return;
				if (message.type === 'inspection-required') reject(new PromotionInspectionRequired());
				else if (message.type === 'unavailable') reject(new PromotedCaptureUnavailable());
				else if (message.type === 'added') resolve(message.captureId);
			};
			channel.postMessage(request);
			interval = setInterval(() => channel.postMessage(request), 750);
		});
		const captureId = await acknowledged;
		app.signal.throwIfAborted();
		const written = store.tables.capturePromotions.update(receipt.id, { captureId });
		if (written.error) throw written.error;
		await store.persistence.flush();
		app.signal.throwIfAborted();
		return captureId;
	} finally {
		if (interval) clearInterval(interval);
		if (timeout) clearTimeout(timeout);
		if (onAbort) app.signal.removeEventListener('abort', onAbort);
		channel.close();
	}
}

export async function openInCapture(
	app: WhisperingApp,
	captureId: string,
): Promise<void> {
	const account = app.authAccount;
	if (!account || app.signal.aborted) throw new Error('Sign in to open Capture.');
	const channel = new BroadcastChannel(CAPTURE_PROMOTION_CHANNEL);
	const request = {
		type: 'open', requestId: crypto.randomUUID(), captureId,
		account: { authorityId: account.authorityId, principalId: account.principalId },
	} as const;
	let interval: ReturnType<typeof setInterval> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		await setCaptureWindowVisible(true);
		app.signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			onAbort = () => reject(new Error('The account changed.'));
			app.signal.addEventListener('abort', onAbort, { once: true });
			timeout = setTimeout(() => reject(new Error('Capture did not open this entry. Try again.')), 20_000);
			channel.onmessage = (event: MessageEvent<CapturePromotionMessage>) => {
				const message = event.data;
				if (!message || message.requestId !== request.requestId ||
					message.account.authorityId !== account.authorityId ||
					message.account.principalId !== account.principalId) return;
				if (message.type === 'unavailable') reject(new PromotedCaptureUnavailable());
				else if (message.type === 'opened' && message.captureId === captureId) resolve();
			};
			channel.postMessage(request);
			interval = setInterval(() => channel.postMessage(request), 750);
		});
	} finally {
		if (interval) clearInterval(interval);
		if (timeout) clearTimeout(timeout);
		if (onAbort) app.signal.removeEventListener('abort', onAbort);
		channel.close();
	}
}

/** Reveal the owning inbox after an ambiguous request, without submitting again. */
export async function inspectCapture(app: WhisperingApp): Promise<void> {
	if (!app.authAccount || app.signal.aborted) throw new Error('Sign in to inspect Capture.');
	await setCaptureWindowVisible(true);
	app.signal.throwIfAborted();
}
