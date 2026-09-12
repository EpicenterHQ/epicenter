import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';
import { buildSessionCallbacks } from '../worker/session-callbacks.js';

const apiRoot = resolve(import.meta.dir, '..');
const uiBuild = resolve(apiRoot, 'ui/build');
const devVars = resolve(apiRoot, '.dev.vars');
const publicOrigin = process.env.API_PUBLIC_ORIGIN ?? localUrl(APPS.API);
const publicUrl = new URL(publicOrigin);
const desktopPort = process.env.EPICENTER_DEV_PORT ?? '39131';
if (
	publicUrl.protocol !== 'http:' ||
	!['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname) ||
	publicUrl.origin !== publicOrigin
) {
	throw new Error(
		'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
	);
}
buildSessionCallbacks(publicOrigin, desktopPort);

// Auth clients and the hosted handoff page must run from the same checkout.
// Rebuild at startup so a leftover shell cannot speak an older auth protocol.
await mkdir(uiBuild, { recursive: true });
const uiBuildRun = await Bun.$`bun run --cwd ui build`.cwd(apiRoot).nothrow();
if (uiBuildRun.exitCode !== 0) {
	process.exit(uiBuildRun.exitCode);
}

// Keep local secrets in Infisical, not a checked-out .dev.vars file. Wrangler's
// `secrets.required` support reads required secrets from process.env during
// local dev; removing stale .dev.vars keeps that source unambiguous.
await rm(devVars, { force: true });

const auth = await Bun.$`infisical --silent user get token --plain`
	.quiet()
	.nothrow();

if (auth.exitCode !== 0 || !auth.stdout.toString().trim()) {
	console.error('Not logged into Infisical.');
	console.error(
		'Running `apps/api` requires Infisical access for dev secrets (API keys, auth secret).',
	);
	console.error('Run `infisical login`, then rerun the same command.');
	console.error(
		'If you do not have Infisical access, see CONTRIBUTING.md for what you can work on without it.',
	);
	process.exit(1);
}

// Wrangler otherwise infers the upstream from production routes and rewrites
// the browser's local Origin header to that production host.
const wrangler =
	await Bun.$`infisical run --silent --env=dev --path=/api -- bun x wrangler dev --local-upstream ${publicUrl.host} --upstream-protocol http --var ${`API_PUBLIC_ORIGIN:${publicOrigin}`} --var ${`EPICENTER_DEV_PORT:${desktopPort}`}`
		.cwd(apiRoot)
		// Dev narrows the public auth origin to localhost. Required auth
		// bindings, including GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, come
		// from Infisical's dev environment through process.env.
		.nothrow();

process.exit(wrangler.exitCode);
