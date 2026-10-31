/**
 * The header's status line says where the person's files are: in this
 * browser signed out, waiting to upload, in the repository, or out of reach.
 * An answer that could not be kept outranks every other line.
 */
import { expect, test } from 'bun:test';
import { headerStatus } from './status.js';

const base = {
	unwrittenAnswers: 0,
	signedIn: true,
	waiting: 0,
	repositoryProblem: undefined,
};

test('signed out, everything is in this browser', () => {
	expect(headerStatus({ ...base, signedIn: false, waiting: 3 })).toMatchObject({
		label: 'In this browser',
		tone: 'neutral',
	});
});

test('signed in, the line counts what is still waiting to upload', () => {
	expect(headerStatus({ ...base, waiting: 2 })).toMatchObject({
		label: '2 not uploaded yet',
		tone: 'busy',
	});
	expect(headerStatus(base)).toMatchObject({
		label: 'In your repository',
		tone: 'good',
	});
});

test('an unreachable repository is a warning, and an unsaved answer outranks it', () => {
	const offline = { ...base, repositoryProblem: 'offline', waiting: 1 };
	expect(headerStatus(offline)).toMatchObject({
		label: 'Repository unreachable',
		tone: 'warning',
	});
	expect(headerStatus({ ...offline, unwrittenAnswers: 1 })).toMatchObject({
		label: '1 answer not saved yet',
		tone: 'error',
	});
});
