import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';

const apiRoot = resolve(import.meta.dir, '..');
const uiBuild = resolve(apiRoot, 'ui/build');
const devVars = resolve(apiRoot, '.dev.vars');
const publicOrigin = process.env.API_PUBLIC_ORIGIN ?? localUrl(APPS.API);
const publicUrl = new URL(publicOrigin);
if (
	publicUrl.protocol !== 'http:' ||
	!['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname) ||
	publicUrl.origin !== publicOrigin
) {
	throw new Error(
		'API_PUBLIC_ORIGIN must be an HTTP loopback origin for local dev.',
	);
}

// The cloud UI SPA is built into apps/api/ui/build/ (SvelteKit
// adapter-static, fallback.html shell). Wrangler errors if its assets
// directory does not exist, and the auth surfaces (/sign-in, /session/callback)
// are served from that build, so build it once when the
// shell is missing. Subsequent boots skip the build to keep the edit loop
// fast; rerun `bun run --cwd apps/api/ui build` after UI changes you want
// visible through wrangler dev.
await mkdir(uiBuild, { recursive: true });
if (!(await Bun.file(resolve(uiBuild, 'fallback.html')).exists())) {
	console.log('Cloud UI shell missing; building apps/api/ui once...');
	const uiBuildRun = await Bun.$`bun run --cwd ui build`.cwd(apiRoot).nothrow();
	if (uiBuildRun.exitCode !== 0) {
		console.error(
			'Cloud UI build failed; /sign-in, /session/callback, and /dashboard will 503 until `bun run --cwd apps/api/ui build` succeeds.',
		);
	}
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

const wrangler =
	await Bun.$`infisical run --silent --env=dev --path=/api -- bun x wrangler dev --var ${`API_PUBLIC_ORIGIN:${publicOrigin}`}`
		.cwd(apiRoot)
		// Dev narrows the public auth origin to localhost. Required auth
		// bindings, including GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, come
		// from Infisical's dev environment through process.env.
		.nothrow();

process.exit(wrangler.exitCode);
