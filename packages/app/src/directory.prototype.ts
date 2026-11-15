/**
 * THROWAWAY PROTOTYPE: keep an upload, create notes, correct a passage.
 * Disk only; no production export. Run: bun packages/cli/examples/interview.prototype.ts
 * Raw filesystem operations borrow the action's guard/lock through folder.update.
 * Static symlinks are refused. Parent checks still race uncoordinated outside moves.
 */
import { randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import {
	link,
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { folder, isLocalPath } from './context.js';
import { MAX_FILE_BYTES, type UploadedFile } from './field.js';
import { readMarkdown } from './front-matter.js';
import { type Placeholders, template, templateProblem } from './path.js';

const markdownBrand = Symbol('prototype Markdown binding');
const claim = Symbol('prototype write claim');
const suffix = '/directory-prototype.md';
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const fold = (name: string) => name.normalize('NFC').toLowerCase();
const missing = (error: unknown) =>
	(error as NodeJS.ErrnoException).code === 'ENOENT';

function safeName(name: string) {
	if (
		!name ||
		!name.isWellFormed() ||
		name.startsWith('.') ||
		/[\x00-\x1f\x7f/\\:]/.test(name) ||
		name.trim() !== name ||
		name.normalize('NFC') !== name ||
		new TextEncoder().encode(name).length > 200 ||
		isLocalPath(name)
	) {
		throw new Error(
			'A kept file needs a safe, non-local basename of at most 200 bytes',
		);
	}
}

/** A body-only Markdown file; its front matter belongs to ordinary file editors. */
export function markdown(path: string) {
	safeName(path);
	if (!path.endsWith('.md'))
		throw new Error('A Markdown binding needs a literal .md basename');
	return { path, [markdownBrand]: true as const };
}

async function info(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (missing(error)) return undefined;
		throw error;
	}
}

async function diskRoot() {
	if (!folder.path)
		throw new Error('This directory prototype needs an action on disk');
	return realpath(folder.path);
}

/** Validate every parent without following a directory link. Only creation makes parents. */
async function parents(root: string, path: string, create: boolean) {
	let at = root;
	for (const part of path.split('/').slice(0, -1)) {
		at = join(at, part);
		let stat = await info(at);
		if (!stat && create) {
			try {
				await mkdir(at);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			stat = await info(at);
		}
		if (!stat) return false;
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error(`${path} has a parent that is not a regular directory`);
	}
	return true;
}

async function regularTarget(root: string, path: string) {
	if (!(await parents(root, path, false))) return undefined;
	const stat = await info(join(root, path));
	if (stat && (!stat.isFile() || stat.isSymbolicLink()))
		throw new Error(`${path} is not a regular file`);
	return stat;
}

async function readText(path: string) {
	const root = await diskRoot();
	if (!(await regularTarget(root, path))) return undefined;
	// O_NOFOLLOW also closes the final-component lstat/open race.
	const file = await open(
		join(root, path),
		constants.O_RDONLY | constants.O_NOFOLLOW,
	);
	try {
		if (!(await file.stat()).isFile())
			throw new Error(`${path} is not a regular file`);
		return decoder.decode(await file.readFile());
	} finally {
		await file.close();
	}
}

async function claimWrite(path: string) {
	// A thrown callback writes nothing. forCall acquires its app lock first;
	// folder.update enforces data/ and the read-only action guard first.
	try {
		await folder.update(path, () => {
			throw claim;
		});
	} catch (error) {
		if (error !== claim) throw error;
	}
}

/** Stage complete bytes beside the destination; link publishes without replacing it. */
async function publish(
	path: string,
	write: (temporary: string) => Promise<number>,
) {
	// Validate links before the claim's existing Folder implementation reads a target.
	await regularTarget(await diskRoot(), path);
	await claimWrite(path);
	const root = await diskRoot();
	await parents(root, path, true);
	const target = join(root, path);
	const siblings = await readdir(dirname(target));
	if (siblings.some((name) => fold(name) === fold(basename(path))))
		throw new Error(`${path} already exists`);
	const temporary = join(dirname(target), `.directory-${randomUUID()}.local`);
	try {
		const size = await write(temporary);
		const staged = await open(temporary, 'r');
		try {
			// A private staging file becomes an ordinary data file when published.
			await staged.chmod(0o666 & ~process.umask());
			await staged.sync();
		} finally {
			await staged.close();
		}
		try {
			await link(temporary, target);
		} catch (error) {
			// Atomic refusal, unlike exists-then-write.
			if ((error as NodeJS.ErrnoException).code === 'EEXIST')
				throw new Error(`${path} already exists`);
			throw error;
		}
		return { path, size };
	} finally {
		await rm(temporary, { force: true });
	}
}

function document(path: string) {
	function parse(text: string) {
		const parsed = readMarkdown(text);
		return {
			...parsed,
			writable:
				parsed.writable &&
				!text.startsWith('\uFEFF') &&
				!(/^---\r?\n/.test(text) && parsed.body === text),
		};
	}
	return {
		path: () => path,
		async get() {
			const text = await readText(path);
			if (text === undefined) return undefined;
			const parsed = parse(text);
			return {
				path,
				body: parsed.body,
				...(!parsed.writable
					? {
							problems: [
								'Malformed front matter or unsupported byte-order mark; repair before editing',
							],
						}
					: {}),
			};
		},
		async create(body: string) {
			if (typeof body !== 'string' || !body.isWellFormed())
				throw new Error('A Markdown body must be well-formed Unicode text');
			if (!parse(body).writable)
				throw new Error(
					`${path} has malformed front matter or a byte-order mark`,
				);
			const bytes = new TextEncoder().encode(body);
			await publish(path, async (temporary) => {
				await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
				return bytes.length;
			});
			return { path, body: readMarkdown(body).body };
		},
		async edit({ old, new: replacement }: { old: string; new: string }) {
			if (
				typeof old !== 'string' ||
				typeof replacement !== 'string' ||
				!old.isWellFormed() ||
				!replacement.isWellFormed()
			)
				throw new Error(
					'A quoted edit needs well-formed old and new Unicode text',
				);
			const root = await diskRoot();
			if (!(await regularTarget(root, path)))
				throw new Error(`${path} is missing`);
			await claimWrite(path);
			const before = await readText(path);
			if (before !== undefined && !parse(before).writable)
				throw new Error(
					`${path} has malformed front matter or a byte-order mark`,
				);
			// Guard malformed front matter inside the update, not just in a stale read.
			const text = await folder.update(path, (current) => {
				if (current === undefined) throw new Error(`${path} is missing`);
				const parsed = parse(current);
				if (!parsed.writable)
					throw new Error(`${path} has malformed front matter`);
				const at = parsed.body.indexOf(old);
				if (old === '' ? parsed.body !== '' : at < 0)
					throw new Error(`${path} no longer contains the quoted passage`);
				if (old !== '' && parsed.body.indexOf(old, at + 1) !== -1)
					throw new Error(`${path} contains the quoted passage more than once`);
				const body =
					old === ''
						? replacement
						: parsed.body.slice(0, at) +
							replacement +
							parsed.body.slice(at + old.length);
				const changed =
					current.slice(0, current.length - parsed.body.length) + body;
				const next = parse(changed);
				if (!next.writable || next.body !== body)
					throw new Error(
						`${path}: a body correction cannot create or change front matter`,
					);
				return changed;
			});
			return { path, body: readMarkdown(text).body };
		},
	};
}

/**
 * An open directory and its understood Markdown files. Selection is pure;
 * keep/create establish files, and an edit never creates missing notes.
 */
export function defineDirectory<
	const TPath extends string,
	const TFiles extends Record<string, ReturnType<typeof markdown>>,
>({ path, files }: { path: TPath; files: TFiles }) {
	const problem = templateProblem(`${path}${suffix}`);
	if (problem || !path.startsWith('data/') || isLocalPath(path))
		throw new Error(
			problem ?? 'A directory must be a non-local path under data/',
		);
	const layout = template(`${path}${suffix}`);
	const reserved = new Set<string>();
	const declared: [string, string][] = [];
	for (const [name, binding] of Object.entries(files)) {
		if (
			[
				'keep',
				'path',
				'then',
				'__proto__',
				'constructor',
				'prototype',
			].includes(name)
		)
			throw new Error(`${name} conflicts with a directory method`);
		if (binding?.[markdownBrand] !== true)
			throw new Error(`${name} is not a Markdown binding`);
		safeName(binding.path);
		if (reserved.has(fold(binding.path)))
			throw new Error('Two bindings name the same document');
		reserved.add(fold(binding.path));
		declared.push([name, binding.path]);
	}
	return {
		at(key: Record<Placeholders<TPath>, string>) {
			for (const name of layout.placeholders) {
				if (typeof key?.[name as Placeholders<TPath>] !== 'string')
					throw new Error(`Select the directory with its ${name}`);
			}
			const selected = layout.fill(key).slice(0, -suffix.length);
			const documents = Object.fromEntries(
				declared.map(([name, filename]) => [
					name,
					document(`${selected}/${filename}`),
				]),
			) as { [TName in keyof TFiles]: ReturnType<typeof document> };
			return {
				...documents,
				path: () => selected,
				/** Copies while the run still owns the upload. Never chooses a primary recording. */
				async keep(upload: UploadedFile) {
					safeName(upload.name);
					if (reserved.has(fold(upload.name)))
						throw new Error('The upload names a declared document');
					const target = `${selected}/${upload.name}`;
					return publish(target, async (temporary) => {
						let size = 0;
						const limit = new Transform({
							transform(chunk: Buffer, _encoding, done) {
								size += chunk.length;
								done(
									size > MAX_FILE_BYTES
										? new Error('The upload exceeds the prototype file limit')
										: null,
									size > MAX_FILE_BYTES ? undefined : chunk,
								);
							},
						});
						await pipeline(
							createReadStream(upload.path()),
							limit,
							createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
						);
						if (size !== upload.size)
							throw new Error('The upload size no longer matches its metadata');
						return size;
					});
				},
			};
		},
	};
}
