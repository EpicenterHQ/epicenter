import { describe, expect, test } from 'bun:test';
import { classifyPush } from './sync.ts';

describe('classifyPush', () => {
	test('a remote that moved first is fetched, merged and pushed again', () => {
		expect(
			classifyPush(
				' ! [rejected]        HEAD -> main (fetch first)\nerror: failed to push some refs',
			),
		).toBe('moved');
		expect(
			classifyPush(
				' ! [remote rejected] HEAD -> main (stale (main moved; fetch first))',
			),
		).toBe('moved');
		expect(
			classifyPush(
				' ! [remote rejected] HEAD -> main (non-fast-forward: only the repository owner may rewrite main; fetch, merge and push again)',
			),
		).toBe('moved');
	});

	test("the receiver's policy stops the round instead of retrying forever", () => {
		expect(
			classifyPush(
				' ! [remote rejected] HEAD -> main (refused (recordings/a.webm must be a Git LFS pointer))',
			),
		).toBe('refused');
		expect(
			classifyPush(
				' ! [remote rejected] HEAD -> main (refused (Git LFS object 1a2b3c4d5e6f for recordings/a.webm is not uploaded; push it with git lfs first))',
			),
		).toBe('refused');
	});

	test('anything else, such as the network, runs again later', () => {
		expect(
			classifyPush(
				"fatal: unable to access 'https://git.epicenter.so/wong/whispering.git/': Could not resolve host",
			),
		).toBe('failed');
	});
});
