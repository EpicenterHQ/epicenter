/**
 * `initFolder`: add a contract to a folder (ADR-0813, ADR-0818), proposing
 * collections from the files already in it (`proposeContract`) and writing
 * them as its `epicenter.json`, titled. A folder needs no contract to sync;
 * this adds checking, tables, tools, and merging by field.
 */
import {
	CONTRACT_PATH,
	isHiddenPath,
	isNotePath,
	type Proposal,
	proposeContract,
} from '@epicenter/definition/contract';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { Store, Unavailable } from '../device/store.js';

export const InitError = defineErrors({
	/** The folder has a contract already, which init never replaces. */
	HasContract: ({ path }: { path: string }) => ({
		message: `${path} has an epicenter.json already; edit it, or remove it to propose one again`,
		path,
	}),
});
export type InitError = InferErrors<typeof InitError>;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The contract the files in `store` suggest, titled `title`, written as its
 * `epicenter.json` unless `dryRun`. Refused when one is there already.
 * `path` names the folder in a refusal.
 */
export async function initFolder({
	store,
	title,
	path,
	dryRun = false,
}: {
	store: Store;
	title: string;
	path: string;
	dryRun?: boolean;
}): Promise<Result<Proposal & { written: boolean }, InitError | Unavailable>> {
	const listed = await store.list(['']);
	if (listed.error !== null) return listed;
	const visible = listed.data.filter(({ path }) => !isHiddenPath(path));
	if (visible.some(({ path }) => path === CONTRACT_PATH))
		return InitError.HasContract({ path });
	const notes = visible.filter(({ path }) => isNotePath(path));
	const read = await store.read(notes.map(({ path }) => path));
	if (read.error !== null) return read;
	const texts = new Map(
		read.data.flatMap((file) =>
			'gone' in file ? [] : [[file.path, decoder.decode(file.bytes)] as const],
		),
	);
	const proposal = proposeContract({
		title,
		files: visible.map(({ path }) => ({ path, text: texts.get(path) })),
	});
	if (dryRun) return Ok({ ...proposal, written: false });
	const put = await store.put(
		CONTRACT_PATH,
		encoder.encode(`${JSON.stringify(proposal.contract, null, '\t')}\n`),
		null,
	);
	if (put.error !== null)
		return put.error.name === 'Moved'
			? InitError.HasContract({ path })
			: { data: null, error: put.error };
	return Ok({ ...proposal, written: true });
}
