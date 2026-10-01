/** Cloudflare-authenticated operator command. Every invocation targets remote state. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { SelfHostOperator } from '../worker/operator.js';

const [worker, operation, id, name, ...extra] = process.argv.slice(2);
if (
	!worker ||
	!id ||
	!['admit', 'recover', 'remove'].includes(operation ?? '') ||
	extra.length ||
	(operation !== 'admit' && name)
)
	throw new Error(
		'Usage: CLOUDFLARE_ACCOUNT_ID=<account-id> bun apps/self-host/scripts/manage-worker-user.ts <worker-name> <admit|recover|remove> <user-id> [display-name]',
	);
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!accountId)
	throw new Error(
		'CLOUDFLARE_ACCOUNT_ID is required to select the operator account.',
	);
const directory = await mkdtemp(join(tmpdir(), 'self-host-operator-'));
try {
	const configPath = join(directory, 'wrangler.json');
	await writeFile(
		configPath,
		JSON.stringify({
			name: 'self-host-operator',
			account_id: accountId,
			compatibility_date: '2026-03-06',
			services: [
				{
					binding: 'OPERATOR',
					service: worker,
					entrypoint: 'SelfHostOperator',
					remote: true,
				},
			],
		}),
		{ mode: 0o600 },
	);
	const platform = await getPlatformProxy<{
		OPERATOR: Service<SelfHostOperator>;
	}>({
		configPath,
		persist: false,
		remoteBindings: true,
	});
	try {
		if (operation === 'remove') {
			await platform.env.OPERATOR.remove(id);
			console.log(
				`Removed access for ${id}. Stored library data was preserved.`,
			);
		} else {
			const grant =
				operation === 'admit'
					? await platform.env.OPERATOR.admit({ id, name: name ?? id })
					: await platform.env.OPERATOR.recover(id);
			console.log(
				`Privately deliver this single-use link to ${id}. It expires at ${new Date(grant.expiresAt).toISOString()}.\n${grant.url}`,
			);
		}
	} finally {
		await platform.dispose();
	}
} finally {
	await rm(directory, { recursive: true, force: true });
}
