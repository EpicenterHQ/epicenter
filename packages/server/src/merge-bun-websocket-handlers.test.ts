import { expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
	type MergedSocketData,
	mergeBunWebSocketHandlers,
} from './merge-bun-websocket-handlers.js';

function socket(surface: MergedSocketData['surface']) {
	return {
		data: { surface },
	} as unknown as ServerWebSocket<MergedSocketData>;
}

test('record document sockets dispatch only to the installed document owner', () => {
	const messages: string[] = [];
	const merged = mergeBunWebSocketHandlers({
		dataDocuments: {
			message(_ws, message) {
				messages.push(String(message));
			},
		},
	});

	merged.message(socket('epicenter-data-document'), 'record update');

	expect(messages).toEqual(['record update']);
});

test('a mounted socket surface fails explicitly when its owner is absent', () => {
	const merged = mergeBunWebSocketHandlers({});

	expect(() =>
		merged.message(socket('epicenter-data-document'), 'record update'),
	).toThrow('Record document WebSocket handler is not installed');
	expect(() => merged.open?.(socket('attach'))).toThrow(
		'Attach WebSocket handler is not installed',
	);
});
