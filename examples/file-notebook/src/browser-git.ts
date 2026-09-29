import LightningFS from '@isomorphic-git/lightning-fs';
import { Buffer } from 'buffer';
import git, { type TreeEntry, type TreeObject } from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import type { BrowserAccountFiles } from './browser-files.js';
import { type FileSnapshot, isLfsPointer } from './files.js';

const dir = '/checkpoint';
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function digest(bytes: Uint8Array): Promise<string> {
	const hash = new Uint8Array(
		await crypto.subtle.digest('SHA-256', bytes as BufferSource),
	);
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(
		'',
	);
}

function pointer(bytes: Uint8Array, oid: string) {
	return encoder.encode(
		`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${bytes.length}\n`,
	);
}

function equal(left: Uint8Array, right: Uint8Array) {
	return (
		left.length === right.length &&
		left.every((byte, index) => byte === right[index])
	);
}

export async function openBrowserGit(
	files: BrowserAccountFiles,
	remote: string,
	name = 'demo-account',
	account = 'demo',
) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(account))
		throw new Error('Invalid account folder name');
	const accountPath = `Epicenter/accounts/${account}`;
	const privateFs = new LightningFS(`epicenter-file-notebook-git-${name}`);
	const fs = privateFs.promises;
	await fs.mkdir(dir).catch(() => {});
	if (
		!(await fs
			.stat(`${dir}/.git`)
			.then(() => true)
			.catch(() => false))
	)
		await git.init({ fs: privateFs, dir, defaultBranch: 'main' });
	await git
		.addRemote({ fs: privateFs, dir, remote: 'origin', url: remote })
		.catch((error: Error) => {
			if (!error.message.includes('already exists')) throw error;
		});
	await git.setConfig({
		fs: privateFs,
		dir,
		path: 'remote.origin.url',
		value: remote,
	});
	const previousAccount = await git.getConfig({
		fs: privateFs,
		dir,
		path: 'epicenter.selectedAccount',
	});
	const head = () =>
		git
			.resolveRef({ fs: privateFs, dir, ref: 'refs/heads/main' })
			.catch(() => undefined);
	const readTree = async (oid: string | undefined): Promise<TreeObject> =>
		oid ? (await git.readTree({ fs: privateFs, dir, oid })).tree : [];
	const entry = (tree: TreeObject, path: string) =>
		tree.find((item) => item.path === path);
	const childTree = async (tree: TreeObject, path: string) =>
		readTree(entry(tree, path)?.oid);
	const replaceEntry = (tree: TreeObject, next: TreeEntry): TreeObject => [
		...tree.filter((item) => item.path !== next.path),
		next,
	];
	const writeTree = (tree: TreeObject) =>
		git.writeTree({ fs: privateFs, dir, tree });

	const lfs = async (
		operation: 'upload' | 'download',
		oid: string,
		size: number,
		bytes?: Uint8Array,
	) => {
		const batch = await fetch(`${remote}/info/lfs/objects/batch`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/vnd.git-lfs+json' },
			body: JSON.stringify({
				operation,
				transfers: ['basic'],
				objects: [{ oid, size }],
			}),
		});
		if (!batch.ok) throw new Error(`LFS ${operation} negotiation failed`);
		const response = (await batch.json()) as {
			objects: {
				error?: { message: string };
				actions?: Record<string, { href: string }>;
			}[];
		};
		const object = response.objects[0];
		if (!object || object.error)
			throw new Error(object?.error?.message ?? 'LFS object unavailable');
		const action = object.actions?.[operation];
		if (!action) {
			if (operation === 'upload') return;
			throw new Error('LFS download action missing');
		}
		const transfer = await fetch(
			action.href,
			operation === 'upload'
				? { method: 'PUT', body: bytes as BodyInit }
				: undefined,
		);
		if (!transfer.ok) throw new Error(`LFS ${operation} failed`);
		if (operation === 'download') {
			const result = new Uint8Array(await transfer.arrayBuffer());
			if (result.length !== size || (await digest(result)) !== oid)
				throw new Error('LFS bytes differ from pointer');
			return result;
		}
	};

	const committed = async (oid: string | undefined) => {
		if (!oid) return new Map<string, Uint8Array>();
		const paths: string[] = [];
		const visit = async (prefix: string) => {
			const tree = await git.readTree({
				fs: privateFs,
				dir,
				oid,
				filepath: prefix,
			});
			for (const item of tree.tree) {
				const path = `${prefix}/${item.path}`;
				if (item.type === 'tree') await visit(path);
				else if (item.type === 'blob') paths.push(path);
			}
		};
		try {
			await visit(accountPath);
		} catch (error) {
			if ((error as { code?: string }).code !== 'NotFoundError') throw error;
		}
		return new Map(
			await Promise.all(
				paths.map(async (path) => {
					const { blob } = await git.readBlob({
						fs: privateFs,
						dir,
						oid,
						filepath: path,
					});
					return [
						path.slice(accountPath.length + 1),
						new Uint8Array(blob),
					] as const;
				}),
			),
		);
	};
	const matches = async (snapshot: FileSnapshot[], oid: string | undefined) => {
		const tree = await committed(oid);
		if (tree.size !== snapshot.length) return false;
		for (const file of snapshot) {
			const blob = tree.get(file.path);
			if (!blob) return false;
			if (isLfsPointer(blob)) {
				const match =
					/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/.exec(
						decoder.decode(blob),
					);
				if (
					!match ||
					file.bytes.length !== Number(match[2]) ||
					(await digest(file.bytes)) !== match[1]
				)
					return false;
			} else if (!equal(file.bytes, blob)) return false;
		}
		return true;
	};
	const incoming = async (oid: string) =>
		Promise.all(
			[...(await committed(oid))].map(async ([path, blob]) => {
				let bytes = blob;
				if (isLfsPointer(bytes)) {
					const match =
						/^version https:\/\/git-lfs.github.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/.exec(
							decoder.decode(bytes),
						);
					if (!match) throw new Error(`Malformed LFS pointer: ${path}`);
					bytes =
						(await lfs('download', match[1]!, Number(match[2]))) ??
						new Uint8Array();
				}
				return { path, bytes };
			}),
		);
	const writeAccountTree = async (snapshot: FileSnapshot[]) => {
		const folders = new Map<string, TreeObject>();
		for (const file of snapshot) {
			let bytes = file.bytes;
			if (/\.jpg$/.test(file.path)) {
				if (isLfsPointer(bytes))
					throw new Error(
						`Image is an LFS pointer, not materialized: ${file.path}`,
					);
				const oid = await digest(bytes);
				await lfs('upload', oid, bytes.length, bytes);
				bytes = pointer(bytes, oid);
			}
			const parts = file.path.split('/');
			const filename = parts.pop()!;
			const folder = parts.join('/');
			folders.set(folder, [
				...(folders.get(folder) ?? []),
				{
					path: filename,
					oid: await git.writeBlob({ fs: privateFs, dir, blob: bytes }),
					type: 'blob',
					mode: '100644',
				},
			]);
			for (let index = 0; index < parts.length; index++) {
				const parent = parts.slice(0, index).join('/');
				if (!folders.has(parent)) folders.set(parent, []);
			}
		}
		for (const folder of [...folders.keys()].sort(
			(a, b) => b.split('/').length - a.split('/').length,
		)) {
			if (!folder) continue;
			const parts = folder.split('/');
			const filename = parts.pop()!;
			const parent = parts.join('/');
			folders.set(parent, [
				...(folders.get(parent) ?? []),
				{
					path: filename,
					oid: await writeTree(folders.get(folder)!),
					type: 'tree',
					mode: '040000',
				},
			]);
		}
		return writeTree(folders.get('') ?? []);
	};
	const lockName = `epicenter-file-notebook-git-${name}`;
	let queue = Promise.resolve();
	function exclusive<T>(action: () => Promise<T>): Promise<T> {
		const run = async (): Promise<T> =>
			typeof navigator !== 'undefined' && navigator.locks
				? await navigator.locks.request(lockName, async () => await action())
				: await action();
		const next = queue.then(run, run);
		queue = next.then(
			() => {},
			() => {},
		);
		return next;
	}
	return {
		status: () =>
			exclusive(async () => {
				const current = await files.snapshot();
				return (await matches(current, await head()))
					? 'No uncommitted file changes'
					: 'Current files differ from last commit';
			}),
		commit: () =>
			exclusive(async () => {
				const snapshot = await files.snapshot();
				const previous = await head();
				const root = await readTree(previous);
				const epicenter = await childTree(root, 'Epicenter');
				const accounts = await childTree(epicenter, 'accounts');
				const accountOid = await writeAccountTree(snapshot);
				const retained =
					previousAccount && previousAccount !== account
						? accounts.filter((item) => item.path !== previousAccount)
						: accounts;
				const accountsOid = await writeTree(
					replaceEntry(retained, {
						path: account,
						oid: accountOid,
						type: 'tree',
						mode: '040000',
					}),
				);
				const epicenterOid = await writeTree(
					replaceEntry(epicenter, {
						path: 'accounts',
						oid: accountsOid,
						type: 'tree',
						mode: '040000',
					}),
				);
				let nextRoot = replaceEntry(root, {
					path: 'Epicenter',
					oid: epicenterOid,
					type: 'tree',
					mode: '040000',
				});
				if (!entry(nextRoot, '.gitattributes')) {
					const oid = await git.writeBlob({
						fs: privateFs,
						dir,
						blob: encoder.encode('*.jpg filter=lfs diff=lfs merge=lfs -text\n'),
					});
					nextRoot = replaceEntry(nextRoot, {
						path: '.gitattributes',
						oid,
						type: 'blob',
						mode: '100644',
					});
				}
				const tree = await writeTree(nextRoot);
				if (
					previous &&
					tree ===
						(await git.readCommit({ fs: privateFs, dir, oid: previous })).commit
							.tree
				)
					return previous;
				const now = Math.floor(Date.now() / 1000);
				const identity = {
					name: 'Field Notebook Demo',
					email: 'demo@example.invalid',
					timestamp: now,
					timezoneOffset: 0,
				};
				const oid = await git.writeCommit({
					fs: privateFs,
					dir,
					commit: {
						message: 'Field notebook commit',
						tree,
						parent: previous ? [previous] : [],
						author: identity,
						committer: identity,
					},
				});
				await git.writeRef({
					fs: privateFs,
					dir,
					ref: 'refs/heads/main',
					value: oid,
					force: true,
				});
				await git.setConfig({
					fs: privateFs,
					dir,
					path: 'epicenter.selectedAccount',
					value: account,
				});
				await fs.flush();
				return oid;
			}),
		push: () =>
			exclusive(async () => {
				await git.push({
					fs: privateFs,
					http,
					dir,
					remote: 'origin',
					ref: 'main',
				});
				await fs.flush();
			}),
		pull: () =>
			exclusive(async () => {
				const before = await files.snapshot();
				const local = await head();
				if (!(await matches(before, local)))
					throw new Error('Current browser files have uncommitted changes');
				await git.fetch({
					fs: privateFs,
					http,
					dir,
					remote: 'origin',
					ref: 'main',
					singleBranch: true,
				});
				const remoteOid = await git.resolveRef({
					fs: privateFs,
					dir,
					ref: 'refs/remotes/origin/main',
				});
				if (local && local !== remoteOid) {
					const remoteAhead = await git.isDescendent({
						fs: privateFs,
						dir,
						oid: remoteOid,
						ancestor: local,
					});
					if (!remoteAhead) {
						const localAhead = await git.isDescendent({
							fs: privateFs,
							dir,
							oid: local,
							ancestor: remoteOid,
						});
						if (localAhead) return local;
						throw new Error(
							'Pull cannot merge divergent commits. Resolve them before pulling.',
						);
					}
				}
				if (local === remoteOid) return remoteOid;
				const next = await incoming(remoteOid);
				await files.applyIncoming(
					before.map(({ path, revision }) => ({ path, revision })),
					next,
				);
				await git.writeRef({
					fs: privateFs,
					dir,
					ref: 'refs/heads/main',
					value: remoteOid,
					force: true,
				});
				await git.setConfig({
					fs: privateFs,
					dir,
					path: 'epicenter.selectedAccount',
					value: account,
				});
				await fs.flush();
				return remoteOid;
			}),
	};
}
