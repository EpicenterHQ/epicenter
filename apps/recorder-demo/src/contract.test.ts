import { expect, test } from 'bun:test';
import { compileContract } from '@epicenter/definition/contract';
import { recorder } from './contract.ts';

test('the published contract is the one in code (run `bun run contract` when it is not)', async () => {
	const published = await Bun.file(
		new URL('../public/contract.json', import.meta.url),
	).json();
	expect(published).toEqual(recorder);
});

test('the contract compiles', () => {
	expect(compileContract(recorder).error).toBeNull();
});
