import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { APPS, localUrl } from '@epicenter/constants/apps';
import type { Unstable_RawConfig as WranglerConfig } from 'wrangler';

const apiRoot = resolve(import.meta.dir, '..');
const uiBuild = resolve(apiRoot, 'ui/build');
const devVars = resolve(apiRoot, '.dev.vars');
const localConfig = resolve(apiRoot, 'wrangler.dev.generated.json');
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

// The authorization server's pages must run from the same checkout as the
// server. Rebuild at startup so a leftover shell cannot speak an older protocol.
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

// Wrangler rewrites localhost Origin headers when a local Worker keeps the
// production custom-domain route, so a development copy removes that route.
// Artifacts has no local simulator. Remove its binding, namespace, and required
// account secret so local dev needs no Artifacts configuration or remote session.
// Hosted Git answers 503 locally. Keep the copy beside wrangler.jsonc so its
// relative paths still resolve.
const config = Bun.JSONC.parse(
	await Bun.file(resolve(apiRoot, 'wrangler.jsonc')).text(),
) as WranglerConfig;
delete config.vars?.ARTIFACTS_NAMESPACE;
await writeFile(
	localConfig,
	JSON.stringify({
		...config,
		routes: [],
		artifacts: [],
		secrets: {
			...config.secrets,
			required: config.secrets?.required?.filter(
				(name) => name !== 'ARTIFACTS_ACCOUNT_ID',
			),
		},
	}),
);
let exitCode: number;
try {
	const wrangler =
		await Bun.$`infisical run --silent --env=dev --path=/api -- bun x wrangler dev --config ${localConfig} --var ${`API_PUBLIC_ORIGIN:${publicOrigin}`}`
			.cwd(apiRoot)
			// Dev narrows the public auth origin to localhost. Required auth
			// bindings, including GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, come
			// from Infisical's dev environment through process.env.
			.nothrow();
	exitCode = wrangler.exitCode;
} finally {
	await rm(localConfig, { force: true });
}

process.exit(exitCode);
