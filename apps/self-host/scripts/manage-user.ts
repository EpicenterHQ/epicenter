/** Local infrastructure command; never mounted as a public server endpoint. */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';

const [operation, id, name] = process.argv.slice(2);
if (!id || !['admit', 'recover', 'remove'].includes(operation ?? ''))
	throw new Error(
		'Usage: bun apps/self-host/scripts/manage-user.ts <admit|recover|remove> <user-id> [display-name]',
	);
const origin =
	process.env.API_PUBLIC_ORIGIN ??
	`http://localhost:${process.env.PORT ?? 8787}`;
const path = resolve(
	import.meta.dir,
	'..',
	process.env.AUTH_DB_PATH ?? './data/auth.sqlite',
);
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const opened = openSelfHostAuth({ path, origin, callbacks: [] });
try {
	if (operation === 'remove') {
		opened.auth.remove(id);
		console.log(`Removed access for ${id}. Stored library data was preserved.`);
	} else {
		const grant =
			operation === 'admit'
				? await opened.auth.admit({ id, name: name ?? id })
				: await opened.auth.recover(id);
		const link = new URL('/sign-in', origin);
		link.hash = new URLSearchParams({ enroll: grant.token }).toString();
		console.log(
			`Privately deliver this single-use link to ${id}. It expires at ${new Date(grant.expiresAt).toISOString()}.\n${link.href}`,
		);
	}
} finally {
	opened.close();
}
