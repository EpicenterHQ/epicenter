/**
 * A standalone desktop app's bundle identifier is the reversed host of its
 * production site (ADR-0722), and the shell derives its data folder from that
 * identifier and the environment its configuration states
 * (`epicenter-standalone`'s `data_folder::identity`). Only the development
 * configuration states one, `development`, and its identifier is the
 * production one with `.dev`, which the shell removes in development alone.
 * This holds every standalone app's Tauri configurations to its `APPS` row,
 * so a renamed bundle or site cannot move an app's folder unnoticed.
 * Epicenter's own desktop shell has no `APPS` URL and is checked separately.
 */

import { expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPS } from './apps.js';

const appsDir = join(import.meta.dir, '..', '..', '..', '..', 'apps');

/** Every app with a production Tauri configuration. */
const desktopApps = readdirSync(appsDir).filter((app) =>
	existsSync(join(appsDir, app, 'src-tauri', 'tauri.conf.json')),
);

type TauriConfig = {
	identifier: string;
	plugins?: Record<string, unknown>;
};

function read(app: string, config: string): TauriConfig {
	return JSON.parse(
		readFileSync(join(appsDir, app, 'src-tauri', config), 'utf8'),
	) as TauriConfig;
}

/** The environment a configuration states for `epicenter-standalone`, if any. */
const environment = (config: TauriConfig) =>
	(
		config.plugins?.['epicenter-standalone'] as
			| { environment?: string }
			| undefined
	)?.environment;

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
		const config = read(app, 'tauri.conf.json');
		const development = read(app, 'tauri.dev.conf.json');
		const production = config.identifier;
		expect(development.identifier).toBe(`${production}.dev`);
		// The environment is stated, and only by the development configuration.
		expect(environment(config)).toBeUndefined();
		expect(environment(development)).toBe('development');
		if (app === 'epicenter') {
			// Epicenter is the library shell, not an app with an APPS site.
			expect(production).toBe('so.epicenter');
			return;
		}
		const host = production.split('.').reverse().join('.');
		const site = sites.find((row) => row.host === host);
		expect(site).toBeDefined();
		if (site?.id !== undefined) expect(site.id).toBe(production);
	});
}
