/**
 * `parseWords` Tests
 *
 * Every command parses the words after it with `parseWords`, which answers a
 * Result. Its error is the one every misuse of a command answers.
 *
 * Key behaviors:
 * - Words that fit are the positionals
 * - A flag, or a wrong number of positionals, is `NotStarted` (`usage`): the
 *   usage line, with the command's help as the next step
 */
import { expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { COMMANDS, parseWords } from './commands.ts';

test('words that fit are the positionals', () => {
	expect(expectOk(parseWords('check', [], [0, 1]))).toEqual([]);
	expect(expectOk(parseWords('check', ['reading'], [0, 1]))).toEqual([
		'reading',
	]);
});

test('any misuse is NotStarted with the usage line and the help as the next step', () => {
	for (const words of [
		['reading', 'vault'],
		['reading', '--nope'],
		['reading', '--from', './x'],
	])
		expect(expectErr(parseWords('check', words, [0, 1]))).toEqual({
			name: 'NotStarted',
			cause: 'usage',
			message: `Usage: ${COMMANDS.check.usage}`,
			next: 'epicenter check --help',
		});
});
