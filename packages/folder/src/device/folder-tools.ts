/**
 * What `epicenter check` and `epicenter format` run over a device's files,
 * for a contract that may have arrived as JSON: whether each file fits it,
 * and every note it claims rewritten in house style.
 */
import {
	checkContract,
	compileContract,
	type FileIssue,
} from '@epicenter/definition/contract';
import { formatNote } from '@epicenter/definition/note';
import { Ok } from 'wellcrafted/result';
import { decodeNote } from '../note-codec.js';
import type { DeviceStore } from './store.js';

/** Whether a path is hidden, and so not the contract's (`checkContract` skips it). */
const isHidden = (path: string) =>
	path.split('/').some((segment) => segment.startsWith('.'));

/**
 * Every file of `store` checked against `contract`: one issue per problem,
 * in path order. A contract that is not well formed is the error.
 */
export async function checkStore(contract: unknown, store: DeviceStore) {
	const compiled = compileContract(contract);
	if (compiled.error !== null) return compiled;
	const { data: listed, error } = await store.list();
	if (error !== null) return { data: null, error };
	const files: { path: string; text?: string }[] = [];
	const unreadable: FileIssue[] = [];
	const paths = listed
		.map(({ path }) => path)
		.filter((path) => !isHidden(path))
		.sort();
	for (const path of paths) {
		if (!path.endsWith('.md')) {
			files.push({ path });
			continue;
		}
		const read = await store.read(path);
		if (read.error !== null) return read;
		if (read.data === null) continue;
		const text = decodeNote(read.data.bytes);
		if (text.error !== null) unreadable.push({ path, message: text.error });
		else files.push({ path, text: text.data });
	}
	const checked = checkContract(contract, files);
	if (checked.error !== null) return checked;
	return Ok({
		files: paths.length,
		issues: [...unreadable, ...checked.data].sort((a, b) =>
			a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
		),
	});
}

/**
 * Rewrite every note a collection of `contract` claims in house style, each
 * only while it still holds the bytes read. A note whose front matter does
 * not parse is left as it is and named in `refused`, as is one that changed
 * while this ran. Files no collection claims are not touched.
 */
export async function formatStore(contract: unknown, store: DeviceStore) {
	const compiled = compileContract(contract);
	if (compiled.error !== null) return compiled;
	const { data: listed, error } = await store.list();
	if (error !== null) return { data: null, error };
	const formatted: string[] = [];
	const refused: { path: string; reason: string }[] = [];
	let unchanged = 0;
	const encoder = new TextEncoder();
	for (const { path } of listed.sort((a, b) => (a.path < b.path ? -1 : 1))) {
		const claim = compiled.data.claim(path);
		if (claim?.collection.kind !== 'note') continue;
		const read = await store.read(path);
		if (read.error !== null) return read;
		if (read.data === null) continue;
		const text = decodeNote(read.data.bytes);
		if (text.error !== null) {
			refused.push({ path, reason: text.error });
			continue;
		}
		const styled = formatNote(text.data, claim.collection.keys);
		if (styled.error !== null) {
			refused.push({
				path,
				reason:
					styled.error.line === undefined
						? styled.error.reason
						: `line ${styled.error.line}: ${styled.error.reason}`,
			});
			continue;
		}
		if (styled.data === text.data) {
			unchanged++;
			continue;
		}
		const written = await store.write(path, encoder.encode(styled.data), {
			sha256: read.data.version,
		});
		if (written.error !== null) return written;
		if (written.data === 'stale')
			refused.push({ path, reason: 'It changed while it was being formatted' });
		else formatted.push(path);
	}
	return Ok({ formatted, unchanged, refused });
}
