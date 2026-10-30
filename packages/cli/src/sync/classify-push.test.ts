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

	test('only the ref status line and its reason classify: a file name elsewhere never does', () => {
		// A refusal naming a file whose name reads like a race stops; it never retries.
		expect(
			classifyPush(
				[
					'To https://git.epicenter.so/wong/notes.git',
					' ! [remote rejected] HEAD -> main (refused (notes/stale-notes.md.bin in 1a2b3c4d is not a Git LFS pointer; files other than .md notes must be stored with Git LFS))',
					"error: failed to push some refs to 'https://git.epicenter.so/wong/notes.git'",
				].join('\n'),
			),
		).toBe('refused');
		expect(
			classifyPush(
				' ! [remote rejected] HEAD -> main (refused (Git LFS object 1a2b3c4d5e6f for rec/non-fast-forward [rejected] cannot lock ref.webm is not uploaded; push it with git lfs first))',
			),
		).toBe('refused');
		// Text outside a status line, even one that reads like a rejection, is not a status.
		expect(
			classifyPush(
				"remote: notes/stale fetch first.md\nfatal: the remote end hung up unexpectedly\nerror: failed to push some refs to 'origin'",
			),
		).toBe('failed');
		// Stock Git's own reasons when a bare remote loses the race on the ref.
		expect(
			classifyPush(
				" ! [remote rejected] HEAD -> main (cannot lock ref 'refs/heads/main': is at 1a2b but expected 3c4d)",
			),
		).toBe('moved');
		expect(
			classifyPush(' ! [remote rejected] HEAD -> main (failed to update ref)'),
		).toBe('moved');
		expect(
			classifyPush(' ! [rejected]        HEAD -> main (non-fast-forward)'),
		).toBe('moved');
		expect(
			classifyPush(
				' ! [remote rejected] HEAD -> main (pre-receive hook declined)',
			),
		).toBe('refused');
		// color.push=always paints the status line.
		expect(
			classifyPush(
				'\x1b[31m ! [rejected]        HEAD -> main (fetch first)\x1b[m',
			),
		).toBe('moved');
	});

	test('anything else, such as the network, runs again later', () => {
		expect(
			classifyPush(
				"fatal: unable to access 'https://git.epicenter.so/wong/whispering.git/': Could not resolve host",
			),
		).toBe('failed');
	});
});
