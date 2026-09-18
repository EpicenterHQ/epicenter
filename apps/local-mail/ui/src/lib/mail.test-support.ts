import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScopedSqlite } from '@epicenter/device/owner';
import type { AccountWorkflow } from '@epicenter/local-mail/accounts';
import type { GmailAuthorization } from './platform/types.js';

let compiled: string | undefined;

/** A fresh document module, with only its application and platform imports replaced. */
export async function openMailDocument({
	app,
	authorization = {
		authorize: async () => new URL('http://localhost/connected'),
	},
}: {
	app: {
		sqlite: ScopedSqlite;
		secrets: AccountWorkflow['secrets'];
	};
	authorization?: GmailAuthorization;
}) {
	const key = `mail-test-${crypto.randomUUID()}`;
	const directory = await mkdtemp(join(tmpdir(), 'mail-document-'));
	const globals = globalThis as unknown as Record<string, unknown>;
	globals[key] = { app: { device: app }, authorization };
	if (!compiled) {
		const built = await Bun.build({
			entrypoints: [new URL('./mail.ts', import.meta.url).pathname],
			target: 'bun',
			plugins: [
				{
					name: 'document-fixture',
					setup(build) {
						build.onResolve(
							{
								filter:
									/^(\.\/application\.js|\.\/identity\.js|#platform\/gmail-authorization)$/,
							},
							(args) => ({ path: args.path, namespace: 'document-fixture' }),
						);
						build.onLoad(
							{ filter: /.*/, namespace: 'document-fixture' },
							(args) => ({
								loader: 'js',
								contents: args.path.includes('application')
									? `export const app = globalThis[${JSON.stringify('MAIL_DOCUMENT_FIXTURE')}].app;`
									: args.path.includes('identity')
										? `export function gmailIdentity() { throw new Error('Local reads must not ask for Gmail identity.'); }`
										: `export const gmailAuthorization = globalThis[${JSON.stringify('MAIL_DOCUMENT_FIXTURE')}].authorization;`,
							}),
						);
					},
				},
			],
		});
		if (!built.success)
			throw new AggregateError(
				built.logs,
				'Could not build the mail document fixture',
			);
		compiled = await built.outputs[0]!.text();
	}
	const path = join(directory, 'mail.js');
	await Bun.write(path, compiled.replaceAll('MAIL_DOCUMENT_FIXTURE', key));
	const { mail } = (await import(path)) as typeof import('./mail.js');
	return {
		mail,
		async cleanup() {
			await mail.close();
			delete globals[key];
			await rm(directory, { recursive: true, force: true });
		},
	};
}
