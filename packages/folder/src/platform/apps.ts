/**
 * The apps a folder can be made by (ADR-0822): an unbound folder named as
 * an app names its folder, with a contract that fits the app, counts as made
 * by that app, and syncs as if the person had chosen to. The platform knows
 * an app only as data (ADR-0819): its client id, the name its desktop app
 * gives its folder (`relativeFolderPath` of its site), the contract its site
 * publishes, and, where known, its view.
 *
 * A folder's contract fits an app when its `epicenter.json` holds each of
 * the view's collections at the same path, each field with the type the
 * view reads (ADR-0812), or, for a folder with no `epicenter.json` (one an
 * app's desktop build made), when its `AGENTS.md` names the contract the
 * app's site publishes.
 */
import { CONTRACT_PATH } from '@epicenter/definition/contract';
import { agentsContract } from '@epicenter/definition/note';
import {
	APPS,
	appDataIdentifier,
	hostFromSiteUrl,
	relativeFolderPath,
} from '@epicenter/definition/site';
import type { Store } from '../device/store.js';

/** A collection as a view or a contract names it: its path, and its fields' schemas. */
type Collections = Record<
	string,
	{ path: string; fields?: Record<string, { type?: unknown }> }
>;

/** An app a folder can be made by. */
export type KnownApp = {
	/** The client id it signs in as, which a folder made for it is attached to. */
	client: string;
	/** The name its desktop build gives its folder in the Epicenter folder. */
	name: string;
	/** The contract its site publishes, which its folders' `AGENTS.md` names. */
	contract: string;
	/** The collections and fields it reads, when known. */
	view?: { collections: Collections };
};

/** The first-party apps, from the app registry: those whose folder is a name directly in the Epicenter folder. */
export function firstPartyApps(): KnownApp[] {
	const apps: KnownApp[] = [];
	for (const [key, app] of Object.entries(APPS)) {
		if (key === 'API' || key === 'SH') continue;
		let host: string;
		try {
			host = hostFromSiteUrl(app.url);
		} catch {
			continue;
		}
		const name = relativeFolderPath(host);
		if (name.includes('/')) continue;
		apps.push({
			client: appDataIdentifier(host, 'production'),
			name,
			contract: `${app.url}/contract.json`,
		});
	}
	return apps;
}

/**
 * Whether `contract` (an `epicenter.json`) holds each of `view`'s
 * collections at the same path, and each field the view reads with the
 * type it reads it as.
 */
export function fitsView(
	view: { collections: Collections },
	contract: unknown,
): boolean {
	const held =
		typeof contract === 'object' && contract !== null
			? ((contract as { collections?: Collections }).collections ?? {})
			: {};
	const byPath = new Map(Object.values(held).map((one) => [one.path, one]));
	return Object.values(view.collections).every((collection) => {
		const there = byPath.get(collection.path);
		if (there === undefined) return false;
		return Object.entries(collection.fields ?? {}).every(([name, field]) => {
			const theirs = there.fields?.[name];
			if (theirs === undefined) return false;
			return (
				field.type === undefined ||
				JSON.stringify(field.type) === JSON.stringify(theirs.type)
			);
		});
	});
}

const decoder = new TextDecoder();

/**
 * The app that made the folder `name` whose files are in `store`, or null:
 * the app whose folder has that name, when the folder's contract fits it.
 */
export async function madeBy(
	name: string,
	store: Store,
	apps: readonly KnownApp[],
): Promise<KnownApp | null> {
	const app = apps.find((one) => one.name.toLowerCase() === name.toLowerCase());
	if (app === undefined) return null;
	const read = await store.read([CONTRACT_PATH, 'AGENTS.md']);
	if (read.error !== null) return null;
	const text = (path: string) => {
		const file = read.data.find((one) => one.path === path);
		return file === undefined || 'gone' in file
			? null
			: decoder.decode(file.bytes);
	};
	const contract = text(CONTRACT_PATH);
	if (contract !== null && app.view !== undefined) {
		try {
			return fitsView(app.view, JSON.parse(contract)) ? app : null;
		} catch {
			return null;
		}
	}
	const agents = text('AGENTS.md');
	if (agents === null) return null;
	const found = agentsContract(agents);
	return found.kind === 'frontmatter' && found.contract === app.contract
		? app
		: null;
}
