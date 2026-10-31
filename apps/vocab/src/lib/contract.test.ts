import { expect, test } from 'bun:test';
import { compileContract } from '@epicenter/definition/contract';
import { vocab } from './contract.js';

test('the published contract is the one in code (run `bun run contract` when it is not)', async () => {
	const published = await Bun.file(
		new URL('../../static/contract.json', import.meta.url),
	).json();
	expect(published).toEqual(JSON.parse(JSON.stringify(vocab)));
});

test('the contract compiles', () => {
	expect(compileContract(vocab).error).toBeNull();
});
