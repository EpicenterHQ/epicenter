/**
 * A device store in memory, for the folder `openFolder` answers under the
 * `test` condition: the same writes as every other store (a create lands
 * only where nothing is, a replacement only over the version its writer
 * read), with nothing kept when the page or process ends. No one else
 * writes it, so it has no outside changes to hear: the client's own writes
 * reach its listeners.
 */
import type { Version } from '@epicenter/definition/contract';
import { Ok } from 'wellcrafted/result';
import { hashBytes } from '../hash.js';
import type { DeviceStore } from './store.js';

export function memoryStore(): DeviceStore {
	const files = new Map<string, { bytes: Uint8Array; version: Version }>();
	let stamps = 0;
	const stampOf = new Map<string, string>();

	return {
		async list() {
			return Ok(
				[...files.keys()].map((path) => ({
					path,
					stamp: stampOf.get(path) ?? '',
				})),
			);
		},
		async read(path) {
			const file = files.get(path);
			if (file === undefined) return Ok(null);
			return Ok({
				bytes: file.bytes.slice(),
				version: file.version,
				stamp: stampOf.get(path) ?? '',
			});
		},
		async write(path, bytes, expected) {
			const file = files.get(path);
			const holds =
				expected === 'absent'
					? file === undefined
					: file?.version === expected.sha256;
			if (!holds) return Ok('stale');
			if (bytes === null) {
				files.delete(path);
				stampOf.delete(path);
				return Ok('landed');
			}
			const version = (await hashBytes(bytes)) as Version;
			files.set(path, { bytes: bytes.slice(), version });
			stampOf.set(path, String(++stamps));
			return Ok('landed');
		},
		watch: () => () => {},
	};
}
