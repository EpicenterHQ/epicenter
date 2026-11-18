/**
 * Data app listings expose keys, paths, descriptions, and JSON Schema.
 * Real CLI invocations verify human and JSON views.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { fixture } from './runner.test-support.ts';

setDefaultTimeout(30_000);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

test('human and JSON app listings show data paths, descriptions, and field schemas', async () => {
	const f = await fixture();
	roots.push(f.userDir);
	await f.app(
		'flights',
		`
export default defineApp(({ folder }) => {
const data = defineData(folder, {
  watches: { description: 'A flight I watch', fields: { from: field.text() } },
  checks: { fields: { watch: field.ref('watches'), many: field.list(field.ref('watches')) } },
  'settings.md': { description: 'My settings', fields: { level: field.integer() } },
});
return { description: 'Flights', data, actions: {} };
});
`,
	);
	const human = await f.run('flights');
	expect(human.code).toBe(0);
	expect(human.stdout).toContain(
		'  watches  data/watches/\n    A flight I watch\n',
	);
	expect(human.stdout).toContain(
		'  settings.md  data/settings.md\n    My settings\n',
	);
	expect(human.stdout).toContain('"properties":{"from":{"type":"string"}}');
	const json = await f.run('flights', '--json');
	expect(json.code).toBe(0);
	const listed = JSON.parse(json.stdout).data;
	expect(listed.data).toMatchObject({
		watches: {
			path: 'data/watches/',
			description: 'A flight I watch',
			fields: {
				type: 'object',
				properties: { from: { type: 'string' } },
				required: ['from'],
			},
		},
		checks: {
			path: 'data/checks/',
			fields: {
				properties: {
					watch: {
						type: 'string',
						'x-epicenter-ref': { key: 'watches' },
					},
					many: { items: { 'x-epicenter-ref': { key: 'watches' } } },
				},
			},
		},
		'settings.md': { path: 'data/settings.md', description: 'My settings' },
	});
	const report = await f.run('--json');
	expect(report.code).toBe(0);
	expect(JSON.parse(report.stdout).data.apps[0].data).toEqual(listed.data);
});
