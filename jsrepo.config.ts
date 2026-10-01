/**
 * jsrepo registry config for Epicenter app blocks.
 *
 * Each app under apps/<app>/blocks/ contributes recipe blocks that consumers
 * copy into their own tree with `bunx jsrepo add epicenter/<app>/<recipe>`.
 * The blocks depend on the npm primitives in @epicenter/app/store, the
 * @epicenter/<app> schema package root, and friends; consumers install those
 * normally. The blocks themselves are owned by the consumer once copied.
 */

import { defineConfig, js, repository } from 'jsrepo';

/**
 * Each app contributes one item per file under `apps/<app>/blocks/`.
 *
 * `workspace.ts` (schema + actions) and `daemon-route.ts` (the long-lived
 * writer) ship for every app. Scripts are not recipes: a script is a
 * user-owned Bun file that reads the local SQLite materializer. There is no
 * daemon write path; writes go through an app or an in-process tool surface
 * (ADR-0112).
 */

const BLOCKS = {
	honeycrisp: ['workspace', 'daemon-route'],
	vocab: ['workspace', 'daemon-route'],
} as const;

export default defineConfig({
	languages: [js()],
	registry: {
		name: '@epicenterhq/epicenter',
		version: 'package',
		homepage: 'https://epicenter.so',
		repository: 'https://github.com/EpicenterHQ/epicenter',
		items: Object.entries(BLOCKS).flatMap(([app, blocks]) =>
			blocks.map((block) => ({
				name: `epicenter/${app}/${block}`,
				type: 'block',
				files: [{ path: `apps/${app}/blocks/${block}.ts` }],
			})),
		),
		outputs: [repository()],
	},
});
