// Generate a reviewable opt-in deployment config; this does not deploy anything.
import type { Unstable_RawConfig as WranglerConfig } from 'wrangler';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '..');
const base = Bun.JSONC.parse(
	await Bun.file(resolve(root, 'wrangler.jsonc')).text(),
) as WranglerConfig;
const path = resolve(root, 'wrangler.homes.generated.json');
await Bun.write(
	path,
	JSON.stringify(
		{
			...base,
			vars: { ...base.vars, HOSTED_HOMES_EXPERIMENT: 'on' },
			services: [
				...(base.services ?? []),
				{
					binding: 'HOSTED_HOMES',
					service: 'epicenter-tasks-workers-prototype',
					entrypoint: 'HomeGateway',
				},
			],
		},
		null,
		2,
	) + '\n',
);
console.log(
	'Generated ' +
		path +
		'. Review the account database and retained DO exports before deployment.',
);
