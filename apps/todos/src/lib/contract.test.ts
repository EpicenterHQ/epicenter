import { expect, test } from 'bun:test';
import { compileContract } from '@epicenter/definition/contract';
import { todos } from './contract.js';

test('the published contract is the one in code (run `bun run contract` when it is not)', async () => {
	const published = await Bun.file(
		new URL('../../static/contract.json', import.meta.url),
	).json();
	expect(published).toEqual(todos);
});

test('the contract compiles', () => {
	expect(compileContract(todos).error).toBeNull();
});
