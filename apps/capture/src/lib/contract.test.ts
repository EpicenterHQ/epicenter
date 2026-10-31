import { expect, test } from 'bun:test';
import { capture } from '@epicenter/capture';

test('the published contract is the one in code (run `bun run contract` when it is not)', async () => {
	const published = await Bun.file(
		new URL('../../static/contract.json', import.meta.url),
	).json();
	expect(published).toEqual(capture);
});
