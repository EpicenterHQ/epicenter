/**
 * `parseWords` Tests
 *
 * Every command parses the words after it with `parseWords`, which answers a
 * Result. Its error is the one every misuse of a command answers.
 *
 * Key behaviors:
 * - Words that fit give the parsed flags and positionals
 * - An unknown flag, a flag missing its value, or a wrong number of
 *   positionals is `NotStarted` (`usage`): the usage line, with the
 *   command's help as the next step
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { COMMANDS, parseWords } from './commands.ts';

test('words that fit parse to their flags and positionals', () => {
	const parsed = expectOk(
		parseWords(
			'new',
			['garden', '--from', './x'],
			{ from: { type: 'string' } },
			[1, 1],
		),
	);
	expect(parsed.positionals).toEqual(['garden']);
	expect(parsed.values.from).toBe('./x');
});

test('any misuse is NotStarted with the usage line and the help as the next step', () => {
	for (const words of [
		[],
		['garden', 'roses'],
		['garden', '--nope'],
		['garden', '--from'],
	])
		expect(
			expectErr(parseWords('new', words, { from: { type: 'string' } }, [1, 1])),
		).toEqual({
			name: 'NotStarted',
			cause: 'usage',
			message: `Usage: ${COMMANDS.new.usage}`,
			next: 'epicenter new --help',
			namespace: 'epicenter/action-error',
		});
});
