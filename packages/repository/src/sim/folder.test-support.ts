/**
 * A folder in the memory world: a device of `harness.ts` whose replica a
 * folder engine keeps in a memory folder (`folder/fs.ts`), with the device's
 * memory blob store, on the world's virtual clock. Bytes the world's server
 * holds live in one map (`lfs`), so a device can fetch what another
 * uploaded. Shared by the folder's scenario tests and its property test.
 */
import { createMemoryBlobStore, createHasher, type Sealed } from '../client/blobs.js';
import { fold } from '../core/door.js';
import { writePointer } from '../core/markdown.js';
import { createFolderEngine, type FolderEngine, ignored, QUIET } from '../folder/engine.js';
import { createMemoryFolderFs, type EventFaults } from '../folder/fs.js';
import type { Device, World } from './harness.js';

/** Let every promise that can settle now settle. */
export const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Run the world's virtual clock for `ms`, settling promises between events, so async work on virtual time interleaves as it would. */
export async function runFor(world: World, ms: number) {
	const end = world.net.now() + ms;
	world.net.after(ms, () => {});
	await drain();
	while (world.net.next(end)) await drain();
}

/** Run the next event on the virtual clock, alone, and settle what it starts: a test that must act between two steps of the engine steps with this. */
export async function step(world: World) {
	const ran = world.net.next();
	await drain();
	return ran;
}

/** Run the virtual clock until `work` settles (at most `limit` ms of virtual time): its answer. */
export async function until<T>(world: World, work: Promise<T>, limit = 600_000): Promise<T> {
	let done = false;
	const settled = work.finally(() => {
		done = true;
	});
	for (let ran = 0; !done && ran < limit; ran += 10) await runFor(world, 10);
	if (!done) throw new Error(`still running after ${limit} ms of virtual time`);
	return settled;
}

/** Bytes the server holds, by oid: what an upload put and a fetch reads. */
export type Lfs = Map<string, Uint8Array>;

export const oidOf = (bytes: Uint8Array): Sealed => {
	const hasher = createHasher();
	hasher.update(bytes);
	return { oid: hasher.digest(), size: bytes.byteLength };
};

export function createFolderDevice(
	world: World,
	name: string,
	{ lfs, faults, quiet = QUIET, scanEvery = null, step }: { lfs: Lfs; faults?: EventFaults; quiet?: number; scanEvery?: number | null; step?: () => number },
) {
	const device: Device = world.device(name);
	const disk = createMemoryFolderFs({ after: world.net.after, now: world.net.now, ...(faults === undefined ? {} : { faults }), ...(step === undefined ? {} : { step }), ignored, fold });
	const store = createMemoryBlobStore();
	let live = false;
	const make = (): FolderEngine =>
		createFolderEngine({
			fs: disk.port,
			replica: device.replica,
			driver: device.driver,
			store,
			async fetch(_path, pointer) {
				const bytes = lfs.get(pointer.oid);
				if (bytes === undefined || world.server.uploaded(pointer.oid) !== pointer.size) return false;
				const sealed = await store.seal(new Blob([bytes as BlobPart]).stream() as ReadableStream<Uint8Array>, { expect: pointer });
				return sealed.error === null;
			},
			after: world.net.after,
			now: world.net.now,
			quiet,
			scanEvery,
		});
	let engine = make();

	return {
		device,
		disk,
		store,
		get engine() {
			return engine;
		},
		get replica() {
			return device.replica;
		},
		/** Start the engine live (watching) or stopped (it only answers `commit`). */
		async start({ watch = true }: { watch?: boolean } = {}) {
			live = watch;
			await engine.start({ watch });
		},
		isLive: () => live,
		/** The process dies mid-work and starts again from its database and the folder: its calls in progress never finish. */
		async crash({ watch = live }: { watch?: boolean } = {}) {
			engine.kill();
			disk.crash();
			device.restart();
			engine = make();
			live = watch;
			// Started in the background: a crash can come again before the startup scan ends.
			void engine.start({ watch });
		},
		/** The upload track sends what this device owes: bytes to the server, then the replica hears they are present. */
		async upload(oid?: string) {
			for (const owed of device.replica.owed()) {
				if (oid !== undefined && owed.oid !== oid) continue;
				const bytes = await store.read(owed.oid);
				if (bytes === null) continue;
				lfs.set(owed.oid, new Uint8Array(await bytes.arrayBuffer()));
				world.server.upload(owed.oid, owed.size);
				device.replica.present(owed.oid, owed.size);
			}
		},
	};
}
export type FolderDevice = ReturnType<typeof createFolderDevice>;

/** A blob another device attaches: its bytes in the LFS map and on the server, and its pointer. */
export function uploadBlob(world: World, lfs: Lfs, bytes: Uint8Array) {
	const sealed = oidOf(bytes);
	lfs.set(sealed.oid, bytes);
	world.server.upload(sealed.oid, sealed.size);
	return writePointer(sealed);
}
