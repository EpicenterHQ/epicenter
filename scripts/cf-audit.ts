#!/usr/bin/env bun
/**
 * Read-only audit of the declared Epicenter Cloudflare zones. Operators change
 * DNS, security settings, and redirect rules in the Cloudflare dashboard; this
 * script never writes.
 *
 * Run from the repository root (production admin operation, needs Infisical):
 *
 *   bun run cf:audit:remote
 *
 * Infisical's production `/ops` path supplies `CLOUDFLARE_ZONE_TOKEN`, which
 * needs only `Zone:Read`, `Zone Settings:Read`, and `DNS:Read` on these zones.
 *
 * Checks per zone: Always Use HTTPS and Automatic HTTPS Rewrites on, strict
 * origin TLS, minimum TLS 1.2 or higher, and Cloudflare's DNSSEC status. HSTS
 * and the DS record are printed as observations, not asserted, because HSTS
 * is a per-hostname commitment (review every subdomain before enabling
 * `includeSubDomains`) and the DS record must be compared with the registrar
 * (`dig +short DS <zone>`). Public SPF and DMARC come from the system resolver
 * with TXT chunks joined; duplicates are issues. `mail: 'none'` zones must have
 * SPF `v=spf1 -all` and DMARC `p=reject`. `external` zones keep provider-managed
 * mail, so do not add a no-mail SPF there. `review` zones have no settled mail
 * policy yet and are observed only.
 *
 * A new zone needs an entry and mail classification below; the list does not
 * discover zones. Keep `epicenter.audio` while its registration is active.
 * Exit 0 means these checks passed; exit 1 means an issue or incomplete read
 * needs review. It does not certify mail delivery, redirects, or the DNSSEC
 * chain. Nothing schedules it: run it when commissioning a domain or after
 * changing domain settings. Redirect rules live on the source zone with
 * proxied DNS (docs/adr/0472, docs/guides/whispering-redirects.md).
 */
import { resolveTxt } from 'node:dns/promises';

const ZONES = [
	{ name: 'epicenter.so', mail: 'external' },
	{ name: 'epicenter.sh', mail: 'review' },
	{ name: 'epicenter.audio', mail: 'none' },
	{ name: 'epicenter.build', mail: 'none' },
	{ name: 'epicenter.chat', mail: 'none' },
	{ name: 'epicenter.email', mail: 'none' },
	{ name: 'epicenter.md', mail: 'external' },
	{ name: 'epicenter.social', mail: 'none' },
	{ name: 'epicenter.software', mail: 'review' },
	{ name: 'getepicenter.com', mail: 'external' },
	{ name: 'getwhispering.com', mail: 'none' },
	{ name: 'opensidian.com', mail: 'none' },
	{ name: 'whispering.studio', mail: 'none' },
] as const;

const WEB_BASELINE = {
	always_use_https: 'on',
	automatic_https_rewrites: 'on',
	ssl: 'strict',
} as const;

const token = process.env.CLOUDFLARE_ZONE_TOKEN;
if (!token)
	throw new Error(
		'CLOUDFLARE_ZONE_TOKEN is not set. Run `bun run cf:audit:remote`.',
	);
if (process.argv.length > 2)
	throw new Error('This audit accepts no arguments.');

let issues = 0;
console.log(`Read-only audit of ${ZONES.length} declared zones`);

for (const zone of ZONES) {
	console.log(`\n${zone.name} (mail: ${zone.mail})`);
	try {
		const matches = await readCloudflare<Array<{ id: string }>>(
			`/zones?name=${encodeURIComponent(zone.name)}`,
		);
		const match = matches[0];
		if (matches.length !== 1 || !match) {
			throw new Error(`Expected one visible zone; found ${matches.length}`);
		}
		const zoneId = match.id;
		const settingIds = [
			...Object.keys(WEB_BASELINE),
			'min_tls_version',
			'security_header',
		];
		const [settings, dnssec, rootTxt, dmarcTxt] = await Promise.all([
			Promise.all(
				settingIds.map(async (id) => {
					const setting = await readCloudflare<{ value: unknown }>(
						`/zones/${zoneId}/settings/${id}`,
					);
					return [id, setting.value] as const;
				}),
			),
			readCloudflare<{ status: string; ds?: string }>(
				`/zones/${zoneId}/dnssec`,
			),
			readTxt(zone.name),
			readTxt(`_dmarc.${zone.name}`),
		]);
		const values = Object.fromEntries(settings);
		for (const [id, expected] of Object.entries(WEB_BASELINE)) {
			check(
				values[id] === expected,
				`${id}: ${JSON.stringify(values[id])}; expected ${expected}`,
			);
		}
		const tls = Number(values.min_tls_version);
		check(
			Number.isFinite(tls) && tls >= 1.2,
			`minimum TLS: ${values.min_tls_version}; expected at least 1.2`,
		);
		console.log(`  observe HSTS: ${JSON.stringify(values.security_header)}`);
		check(
			dnssec.status === 'active',
			`Cloudflare DNSSEC status: ${dnssec.status}`,
		);
		if (dnssec.ds) console.log(`  observe DS: ${dnssec.ds}`);

		const spf = rootTxt.filter((record) => /^v=spf1(?:\s|$)/i.test(record));
		const dmarc = dmarcTxt.filter((record) =>
			/^v=DMARC1(?:;|\s|$)/i.test(record),
		);
		console.log(`  public SPF: ${JSON.stringify(spf)}`);
		console.log(`  public DMARC: ${JSON.stringify(dmarc)}`);
		check(
			spf.length <= 1,
			`SPF record count: ${spf.length}; duplicates need review`,
		);
		check(
			dmarc.length <= 1,
			`DMARC record count: ${dmarc.length}; duplicates need review`,
		);
		if (zone.mail === 'none') {
			check(
				spf.length === 1 && spf[0]?.toLowerCase() === 'v=spf1 -all',
				'no-mail SPF must be v=spf1 -all',
			);
			check(
				dmarc.length === 1 &&
					/(?:^|;)\s*p\s*=\s*reject\s*(?:;|$)/i.test(dmarc[0] ?? ''),
				'no-mail DMARC must specify p=reject',
			);
		}
	} catch (error) {
		issues++;
		console.error(
			`  error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

console.log(
	`\n${issues} issue(s). HSTS observations and DNSSEC delegation require separate review.`,
);
process.exitCode = issues > 0 ? 1 : 0;

function check(passed: boolean, message: string) {
	console.log(`  ${passed ? 'ok' : 'issue'} ${message}`);
	if (!passed) issues++;
}

async function readCloudflare<T>(path: string): Promise<T> {
	const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(20_000),
	});
	const body = (await response.json()) as {
		success: boolean;
		result: T;
		errors?: Array<{ code: number; message: string }>;
	};
	if (!response.ok || !body.success) {
		throw new Error(
			`Cloudflare GET ${path} failed (${response.status}): ${JSON.stringify(body.errors)}`,
		);
	}
	return body.result;
}

async function readTxt(name: string) {
	try {
		return (await resolveTxt(name)).map((chunks) => chunks.join(''));
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			(error.code === 'ENODATA' || error.code === 'ENOTFOUND')
		)
			return [];
		throw error;
	}
}
