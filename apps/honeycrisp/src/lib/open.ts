/**
 * Open this browser's Honeycrisp repository: the replica of `honeycrisp`
 * here, or a new one the first time. With a server it syncs as `account`,
 * whom the development server takes from `Authorization: Bearer <account>`.
 */
import { createBrowserRepository, openBrowserRepository } from '@epicenter/repository/api/browser';
import { listReplicas } from '@epicenter/repository/hosts/browser';
import { Ok } from 'wellcrafted/result';
import { honeycrispApp } from './data.js';

export async function openHoneycrisp({ server, account }: { server: string | undefined; account: string }) {
	const headers: Record<string, string> = server === undefined ? {} : { authorization: `Bearer ${account}` };
	const found = (await listReplicas()).find((manifest) => manifest.repository === 'honeycrisp');
	if (found !== undefined) return Ok(openBrowserRepository({ app: honeycrispApp, replica: found.replica, headers }));
	const created = await createBrowserRepository({ app: honeycrispApp, repository: 'honeycrisp', name: 'Honeycrisp', account: server === undefined ? null : account, url: server ?? null, headers });
	if (created.error !== null) return created;
	return Ok(created.data.repository);
}
