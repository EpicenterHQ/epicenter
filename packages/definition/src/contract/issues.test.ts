import { expect, test } from 'bun:test';
import { describeIssues } from './issues.js';

test('each issue reads as its field and message, and one about the whole note as its message alone', () => {
	expect(
		describeIssues([
			{ field: 'done', message: 'is required' },
			{ field: '', message: 'The front matter does not parse' },
		]),
	).toBe('done: is required; The front matter does not parse');
	expect(describeIssues([])).toBe('');
});
