import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { defineAction } from './action.ts';
import { programOf } from './command/program.ts';
import { defineEpicenter } from './epicenter.ts';
import { field } from './field.ts';

test('a schedule uses the named action’s input, in TypeScript and at startup', () => {
	const apps = {
		flights: {
			description: 'Flights',
			actions: {
				daily: defineAction({
					description: 'Check due flights',
					input: { recheck: field.boolean({ optional: true }) },
					run: () => Ok(null),
				}),
				get: defineAction({
					description: 'Get a watch by id',
					input: { id: field.text() },
					run: () => Ok(null),
				}),
			},
		},
	};
	const cron = '0 8 * * *';
	const schedules = {
		morning: { cron, action: ['flights', 'daily'], input: {} },
	} as const;
	expect(
		programOf(defineEpicenter({ apps, schedules })).problem,
	).toBeUndefined();
	expect(
		programOf(
			defineEpicenter({
				apps,
				schedules: {
					// @ts-expect-error Action names come from apps.
					morning: { cron, action: ['flights', 'daliy'], input: {} },
				},
			}),
		).problem,
	).toContain('there is no action flights daliy');
	expect(
		programOf(
			defineEpicenter({
				apps,
				schedules: {
					morning: {
						cron,
						action: ['flights', 'daily'],
						// @ts-expect-error The named action expects a boolean recheck.
						input: { recheck: 'yes' },
					},
				},
			}),
		).problem,
	).toContain('recheck');
	expect(
		programOf(
			defineEpicenter({
				apps,
				schedules: {
					// @ts-expect-error The other action requires an id.
					morning: { cron, action: ['flights', 'get'], input: {} },
				},
			}),
		).problem,
	).toContain('id is needed');
});
