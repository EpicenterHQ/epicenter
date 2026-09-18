/**
 * Transcription Delivery Tests
 *
 * Locks the settings-to-sink routing for transcript delivery. The clipboard-only
 * Dictate path is easy to regress because no type changes when cursor-off
 * delivery falls back to history instead of copying externally.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const delivered: string[] = [];
const settingsValues = new Map<string, boolean>();

mock.module('$app/navigation', () => ({
	goto: mock(),
}));

mock.module('$app/paths', () => ({
	resolve: (pathname: string) => `/apps/whispering${pathname}`,
}));

mock.module('$lib/operations/sink', () => ({
	clipboardSink: {
		kind: 'clipboard',
		async deliver(text: string) {
			delivered.push(`clipboard:${text}`);
			return 'output';
		},
	},
	ledgerSink: {
		kind: 'ledger',
		async deliver(text: string) {
			delivered.push(`ledger:${text}`);
			return 'output';
		},
	},
	createCursorSink({
		keepOnClipboard,
		pressEnter,
	}: {
		keepOnClipboard: boolean;
		pressEnter: boolean;
	}) {
		return {
			kind: 'cursor',
			async deliver(text: string) {
				delivered.push(`cursor:${text}:${keepOnClipboard}:${pressEnter}`);
				return 'output';
			},
		};
	},
}));

const { deliverTranscriptionResult } = await import(
	'../src/lib/operations/delivery'
);
type WhisperingApp = import('../src/lib/whispering/app').WhisperingApp;

const app = {
	settings: {
		get(key: string) {
			return settingsValues.get(key) ?? false;
		},
	},
} as unknown as WhisperingApp;

describe('transcription delivery', () => {
	beforeEach(() => {
		delivered.length = 0;
		settingsValues.clear();
		settingsValues.set('outputTranscriptionClipboard', false);
		settingsValues.set('outputTranscriptionCursor', false);
		settingsValues.set('outputTranscriptionEnter', false);
	});

	test('cursor off and clipboard on copies to the clipboard sink', async () => {
		settingsValues.set('outputTranscriptionClipboard', true);

		const result = await deliverTranscriptionResult(app, { text: 'hello' });

		expect(result.outcome).toEqual({ reach: 'output' });
		expect(delivered).toEqual(['clipboard:hello']);
	});

	test('cursor off and clipboard off delivers to history only', async () => {
		const result = await deliverTranscriptionResult(app, { text: 'hello' });

		expect(result.outcome).toEqual({ reach: 'output' });
		expect(delivered).toEqual(['ledger:hello']);
	});
});
