/**
 * A standalone desktop app's bundle identifier is the reversed host of its
 * production site (ADR-0722), and the shell derives its data folder from that
 * identifier alone (`epicenter-standalone`'s `data_folder::identity`). This
 * holds every standalone app's Tauri configurations to its `APPS` row, so a
 * renamed bundle or site cannot move an app's folder unnoticed. Epicenter's
 * own desktop shell has no `APPS` URL and is checked separately.
 */

import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPS } from './apps.js';

const appsDir = join(import.meta.dir, '..', '..', '..', 'apps');

/** Every app with a production Tauri configuration. */
const desktopApps = readdirSync(appsDir).filter((app) =>
	existsSync(join(appsDir, app, 'src-tauri', 'tauri.conf.json')),
);

function identifier(app: string, config: string): string {
	const parsed: unknown = JSON.parse(
		readFileSync(join(appsDir, app, 'src-tauri', config), 'utf8'),
	);
	return (parsed as { identifier: string }).identifier;
}

const sites = Object.values(APPS).map(
	(row): { host: string; id: string | undefined } => ({
		host: new URL(row.url).host,
		id: 'id' in row ? row.id : undefined,
	}),
);

test('every desktop app is enumerated', () => {
	expect(desktopApps).toEqual(
		expect.arrayContaining([
			'capture',
			'epicenter',
			'honeycrisp',
			'todos',
			'vocab',
			'whispering',
		]),
	);
});

for (const app of desktopApps) {
	test(`${app}'s bundle identifier is its site's reversed host`, () => {
		const production = identifier(app, 'tauri.conf.json');
		expect(production.endsWith('.dev')).toBe(false);
		expect(identifier(app, 'tauri.dev.conf.json')).toBe(`${production}.dev`);
		if (app === 'epicenter') {
			// Epicenter is the library shell, not an app with an APPS site.
			expect(production).toBe('so.epicenter');
			return;
		}
		const host = production.split('.').reverse().join('.');
		expect(host.split('.')[0]).not.toBe('dev');
		const site = sites.find((row) => row.host === host);
		expect(site).toBeDefined();
		if (site?.id !== undefined) expect(site.id).toBe(production);
	});
}
