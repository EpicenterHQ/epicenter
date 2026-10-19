/**
 * Open Refusal Tests
 *
 * The refusal screen's words for the refusals a person meets in the desktop
 * app, where a window can be handed a folder the app does not read.
 *
 * Key behaviors:
 * - A folder that does not declare the app's tables keeps the library's
 *   message, which names the app, the folder, and each missing table
 * - A window opened for another app says which, and how to open this one
 * - Only a refusal that may pass offers "Try again"
 */
import { expect, test } from 'bun:test';
import { OpenFolderError } from '@epicenter/folder';
import { describeOpenRefusal } from './open-refusal.js';

test('a folder without the app tables names them, and opening again would not help', () => {
	const { error } = OpenFolderError.DefinitionMismatch({
		app: 'Todos',
		folder: 'Recipes',
		problems: [
			{
				kind: 'missingTable',
				table: 'todos',
				message: "The folder declares no 'todos' table",
			},
		],
	});
	expect(describeOpenRefusal(error, 'Todos')).toEqual({
		description:
			"Todos cannot open the folder 'Recipes': The folder declares no 'todos' table. Open this folder with an app that reads it.",
		retry: false,
	});
});

test('a window opened for another app says which', () => {
	expect(
		describeOpenRefusal(
			OpenFolderError.AppMismatch({
				app: 'so.epicenter.todos',
				windowApp: 'so.epicenter.honeycrisp',
			}).error,
			'Todos',
		).description,
	).toBe(
		"This window was opened for 'so.epicenter.honeycrisp', so Todos cannot open a folder in it.",
	);
	expect(
		describeOpenRefusal(
			OpenFolderError.Unavailable({ cause: new Error('disk') }).error,
			'Todos',
		).retry,
	).toBe(true);
});

test('older browser data is named as retained without offering an empty retry', () => {
	expect(
		describeOpenRefusal(
			OpenFolderError.LegacyDataPresent({ folders: ['so.epicenter.todos'] }).error,
			'Todos',
		),
	).toEqual({
		description:
			'Your earlier Todos files are still stored in this browser. This version cannot read them yet, so it stopped before showing an empty workspace.',
		retry: false,
	});
});
