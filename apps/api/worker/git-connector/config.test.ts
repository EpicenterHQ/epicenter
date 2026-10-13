import { expect, test } from 'bun:test';
import {
	gitHubConnectorCallbacks,
	TODOS_SYNC_CALLBACK,
	ZHONGWEN_SYNC_CALLBACK,
} from './config.js';

test('a local API admits exact development callbacks for both apps', () => {
	for (const origin of ['http://localhost:8787', 'http://127.0.0.1:8787']) {
		expect(gitHubConnectorCallbacks(origin)).toEqual([
			ZHONGWEN_SYNC_CALLBACK,
			TODOS_SYNC_CALLBACK,
			'http://localhost:5207/sync',
			'http://127.0.0.1:5207/sync',
			'http://localhost:5186/sync',
			'http://127.0.0.1:5186/sync',
		]);
	}
});

test('a deployed API admits no development callback', () => {
	expect(gitHubConnectorCallbacks('https://api.epicenter.so')).toEqual([
		ZHONGWEN_SYNC_CALLBACK,
		TODOS_SYNC_CALLBACK,
	]);
});
