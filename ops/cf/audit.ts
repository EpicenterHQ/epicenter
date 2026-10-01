#!/usr/bin/env bun
/** Read-only checks for the declared Epicenter zones. See ops/README.md. */
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
	throw new Error('CLOUDFLARE_ZONE_TOKEN is not set. See ops/README.md.');
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
