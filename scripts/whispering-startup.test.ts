/**
 * Whispering captures one Account for opening and displays the selected store
 * from the ready App. Signed-out startup always displays device data regardless
 * of the saved choice. Separate processes isolate captured module state.
 * Honeycrisp startup is covered by its routed browser acceptance test.
 */
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

for (const saved of [null, 'local', 'personal', 'shared']) {
	test(`Whispering opens device data after sign-out from ${saved}`, () => {
		const result = Bun.spawnSync(
			[
				process.execPath,
				'--eval',
				`
				import assert from 'node:assert/strict';
				import { mock } from 'bun:test';
				const saved = ${JSON.stringify(saved)};
				const values = new Map([['whispering.library', saved]]);
				globalThis.localStorage = {
					getItem: key => values.get(key) ?? null,
					setItem: (key, value) => values.set(key, value),
				};
				globalThis.location = { search: '' };
				const auth = { state: { account: undefined } };
				const startup = { auth, selectedServer: 'https://server.example' };
				mock.module('#platform/auth', () => ({ authClient: startup }));
				mock.module('@epicenter/app-shell/inference-selections', () => ({
					createBrowserInferenceSelections: () => ({ [Symbol.dispose]() {} }),
				}));
				mock.module('@epicenter/app-shell/departure', () => ({ createDeparture: () => ({}) }));
				const definition = { id: 'test.whispering' };
				mock.module(process.cwd() + '/src/lib/data.ts', () => ({ whisperingDefinition: definition }));
				const calls = [];
				mock.module('@epicenter/app/open', () => ({
					openApp(definitionArgument, options) {
						assert.equal(definitionArgument, definition);
						const pending = Promise.withResolvers();
						calls.push({ account: options.account, pending });
						return pending.promise;
					},
				}));
				const visits = [];
				for (const principalId of [undefined, 'alice', undefined, 'alice']) {
					const account = principalId ? { principalId } : undefined;
					auth.state.account = account;
					const opened = await import(process.cwd() + '/src/lib/bootstrap.ts?visit=' + visits.length);
					assert.equal(calls.length, visits.length + 1);
					assert.equal(calls.at(-1).account, account);
					assert.equal(opened.account, account);
					// A later auth state must not change the Account or data this opening uses.
					auth.state.account = { principalId: 'replacement' };
					const app = {
						device: { owner: principalId ?? 'no-account' },
						account: account && { personal: {}, shared: {} },
						signal: new AbortController().signal,
						close: async () => {},
					};
					calls.at(-1).pending.resolve(app);
					const ready = await opened.opening;
					assert.equal(ready.app, app);
					const library = account ? saved ?? 'personal' : 'local';
					assert.equal(ready.data, library === 'local' ? app.device : app.account[library]);
					visits.push({ library: opened.library, owner: ready.app.device.owner });
				}
				console.log(JSON.stringify({ visits, saved: values.get('whispering.library') }));
			`,
			],
			{
				cwd: fileURLToPath(new URL('../apps/whispering/', import.meta.url)),
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		expect(result.exitCode, result.stderr.toString()).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toEqual({
			visits: [
				{ library: 'local', owner: 'no-account' },
				{ library: saved ?? 'personal', owner: 'alice' },
				{ library: 'local', owner: 'no-account' },
				{ library: saved ?? 'personal', owner: 'alice' },
			],
			saved,
		});
	});
}
