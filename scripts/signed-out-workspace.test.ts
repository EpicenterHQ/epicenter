/**
 * Application bootstraps return to the no-account library after sign-out,
 * even when Personal or Shared was the last view. Each probe runs in its own
 * process so module mocks and captured page state cannot leak between apps.
 * App scope tests separately verify persisted rows and referenced audio.
 */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

for (const product of ['honeycrisp', 'whispering']) {
	for (const saved of [null, 'local', 'personal', 'shared']) {
		test(`${product} returns to no-account after sign-out from ${saved}`, () => {
			const cwd = fileURLToPath(
				new URL(`../apps/${product}/`, import.meta.url),
			);
			const result = Bun.spawnSync(
				[
					process.execPath,
					'--eval',
					`
				import { mock } from 'bun:test';
				const product = ${JSON.stringify(product)};
				const saved = ${JSON.stringify(saved)};
				const entry = product === 'whispering' ? 'bootstrap' : 'application';
				const values = new Map([[product + '.library', saved]]);
				globalThis.localStorage = {
					getItem: key => values.get(key) ?? null,
					setItem: (key, value) => values.set(key, value),
				};
				globalThis.location = { search: '' };
				const auth = { state: { account: undefined } };
				const startup = { auth, selectedServer: 'https://server.example' };
				mock.module('#platform/auth', () => ({ authStartup: startup, authClient: startup }));
				if (product === 'whispering') {
					mock.module('@epicenter/app-shell/inference-selections', () => ({ createBrowserInferenceSelections: () => ({ [Symbol.dispose]() {} }) }));
				}
				mock.module('@epicenter/app-shell/departure', () => ({ createDeparture: () => ({}) }));
				mock.module(process.cwd() + '/src/lib/data.ts', () => ({ [product + 'Definition']: {
					open(account) {
						return { device: { owner: account?.principalId ?? 'no-account', library: 'local' },
							account: account && { personal: { owner: account.principalId, library: 'personal' }, shared: { library: 'shared' } },
							ready: Promise.resolve({ error: null }), close: async () => {} };
					}
				} }));
				const visits = [];
				for (const principalId of [undefined, 'alice', undefined, 'alice']) {
					auth.state.account = principalId ? { principalId } : undefined;
					const opened = await import(process.cwd() + '/src/lib/' + entry + '.ts?visit=' + visits.length);
					visits.push({ library: opened.library, owner: opened.app.device.owner, hasData: !!opened.data });
				}
				console.log(JSON.stringify({ visits, saved: values.get(product + '.library') }));
			`,
				],
				{ cwd, stdout: 'pipe', stderr: 'pipe' },
			);
			expect(result.exitCode, result.stderr.toString()).toBe(0);
			expect(JSON.parse(result.stdout.toString())).toEqual({
				visits: [
					{ library: 'local', owner: 'no-account', hasData: true },
					{ library: saved ?? 'personal', owner: 'alice', hasData: true },
					{ library: 'local', owner: 'no-account', hasData: true },
					{ library: saved ?? 'personal', owner: 'alice', hasData: true },
				],
				saved,
			});
		});
	}
}
