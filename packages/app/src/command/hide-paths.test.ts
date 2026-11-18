import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hidePaths } from './hide-paths.ts';

test('the Epicenter reads . and the home folder ~, as paths or file URLs, and only as whole paths', () => {
	const folder = join(homedir(), 'My Epicenter');
	const hide = hidePaths({ folder });
	expect(hide.text(`stat '${folder}/apps/notes'`)).toBe("stat './apps/notes'");
	expect(hide.text(`${pathToFileURL(folder).href}/apps/x.ts`)).toBe(
		'./apps/x.ts',
	);
	expect(hide.text(`${homedir()}/Code`)).toBe('~/Code');
	// A longer name that starts with the home folder's is not the home folder.
	expect(hide.text(`${homedir()}-old/x`)).toBe(`${homedir()}-old/x`);
	expect(hide.text(`${folder}2/x`)).toBe('~/My Epicenter2/x');
	// A path that ends a sentence is still the path; a name after a dot is not.
	expect(hide.text(`Cannot read ${folder}. Try again`)).toBe(
		'Cannot read .. Try again',
	);
	expect(hide.text(`${folder}.old/x`)).toBe('~/My Epicenter.old/x');
});

test('a value is rebuilt only where it is a plain object or array', () => {
	const folder = join(homedir(), 'Epicenter');
	const hide = hidePaths({ folder });
	const when = new Date(0);
	const shown = hide.value({ when, list: [`${folder}/a`] });
	expect(shown.when).toBe(when);
	expect(shown.list).toEqual(['./a']);
});

test('an answer hides its error and keeps its data as the action returned it', () => {
	const folder = join(homedir(), 'Epicenter');
	const hide = hidePaths({ folder });
	expect(hide.answer({ data: `${folder}/a`, error: null })).toEqual({
		data: `${folder}/a`,
		error: null,
	});
	expect(
		hide.answer({
			data: null,
			error: {
				name: 'NotStarted',
				cause: 'app-problems',
				message: `${folder}/apps/a`,
				problems: [`${folder}/apps/a/code`],
			} as never,
		}),
	).toEqual({
		data: null,
		error: {
			name: 'NotStarted',
			cause: 'app-problems',
			message: './apps/a',
			problems: ['./apps/a/code'],
		} as never,
	});
});
