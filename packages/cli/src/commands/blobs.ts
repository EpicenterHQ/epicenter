/**
 * `epicenter blobs`: trade a file that does not fit in git for a durable
 * opaque-id URL. The caller mints the BlobId; S3 remains the only remote index.
 *
 *   add <file|url>      mint an id, then upload (ticket -> presigned PUT
 *                       straight to the store) and print the URL; writes
 *                       nothing to disk
 *   get <blobId|url>    download one blob by id to a file
 *   rm  <blobId|url>    delete one blob from the store (breaks every citation)
 *
 * Address-only by design (ADR-0154): every verb takes a BlobId the caller
 * already holds. There is no `ls`; the documents citing a blob are the only
 * inventory, so enumeration is a grep over your own data, not a store call.
 *
 * Every subcommand is a direct cloud round-trip built from the resolved machine
 * auth client (the persisted OAuth cell, or a configured instance token for a
 * self-hosted star). Blob references remain application-owned; the remote
 * bucket is only an explicit same-id remote copy.
 *
 * Exit codes: 1 for a local problem (auth, reading a source file), 2 when the
 * cloud round-trip itself fails.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as machineAuth from '@epicenter/auth/node';
import { type BlobId, generateBlobId, parseBlobId } from '@epicenter/blobs';
import { createEpicenterClient, type EpicenterClient } from '@epicenter/client';
import mime from 'mime';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { cmd } from '../util/cmd.js';
import { fail, formatOptions, output } from '../util/format-output.js';

/** An `add` source that looks like an http(s) URL is handed to the SDK to
 * fetch; anything else is read from disk. */
const HTTP_URL = /^https?:\/\//i;

const addCommand = cmd({
	command: 'add <source>',
	describe: 'Upload a file or http(s) URL and print its blob URL',
	builder: (yargs) =>
		yargs
			.positional('source', {
				type: 'string',
				demandOption: true,
				describe: 'A local file path or an http(s) URL',
			})
			.option('content-type', {
				type: 'string',
				describe: 'Override the content type (else inferred from the source)',
			})
			// The shared json/jsonl pair plus a plain mode: the bare URL on stdout,
			// so `$(epicenter blobs add x.png)` drops straight into a document.
			.option('format', {
				type: 'string',
				choices: ['json', 'jsonl', 'plain'] as const,
				describe:
					"Output format (default: json, auto-pretty for TTY; 'plain' prints the bare URL)",
			})
			.strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		// Source resolution belongs to the Bun shell. The portable client accepts
		// only Blob/File bodies, so WebKit never needs request-stream semantics.
		const { data: source, error: readError } = HTTP_URL.test(argv.source)
			? await readHttpUrl(argv.source)
			: await readLocalFile(argv.source);
		if (readError !== null) {
			fail(readError);
			return;
		}

		const blobId = generateBlobId();
		const { data: result, error: uploadError } = await epicenter.blobs.add(
			blobId,
			source,
			{ contentType: argv.contentType },
		);
		if (uploadError !== null) {
			fail(uploadError.message, { code: 2 });
			return;
		}

		if (argv.format === 'plain') {
			console.log(result.url);
			return;
		}
		output({ blobId: result.blobId, url: result.url }, { format: argv.format });
	},
});

const getCommand = cmd({
	command: 'get <blob>',
	describe: 'Download a blob by id and write it to a file',
	builder: (yargs) =>
		yargs
			.positional('blob', {
				type: 'string',
				demandOption: true,
				describe: 'A BlobId, or a blob URL containing one',
			})
			.option('output', {
				alias: 'o',
				type: 'string',
				describe: 'Destination path (default: <blobId>.<ext> in the cwd)',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const { data: blobId, error: parseError } = parseBlobReference(argv.blob);
		if (parseError !== null) {
			fail(parseError);
			return;
		}

		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: res, error } = await epicenter.blobs.get(blobId);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}

		const bytes = Buffer.from(await res.arrayBuffer());

		// Content type rides on the stored object (pinned at upload), so it names
		// the extension when the caller did not pick an output path.
		const contentType =
			res.headers.get('content-type') ?? 'application/octet-stream';
		const ext = mime.getExtension(contentType);
		const outputPath = path.resolve(
			argv.output ?? (ext ? `${blobId}.${ext}` : blobId),
		);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, bytes);

		output(
			{
				blobId,
				output: path.relative(process.cwd(), outputPath),
				size_bytes: bytes.byteLength,
				content_type: contentType,
			},
			{ format: argv.format },
		);
	},
});

// Removes the cloud object only; local files are yours to manage.
const rmCommand = cmd({
	command: 'rm <blob>',
	describe:
		'Delete a blob from the store by id; every URL citing it breaks forever (idempotent)',
	builder: (yargs) =>
		yargs
			.positional('blob', {
				type: 'string',
				demandOption: true,
				describe: 'A BlobId, or a blob URL containing one',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const { data: blobId, error: parseError } = parseBlobReference(argv.blob);
		if (parseError !== null) {
			fail(parseError);
			return;
		}

		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { error } = await epicenter.blobs.delete(blobId);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}
		output({ blobId, deleted: true }, { format: argv.format });
	},
});

export const blobsCommand = cmd({
	command: 'blobs <subcommand>',
	describe: 'Upload and retrieve bytes in the remote blob store',
	builder: (yargs) =>
		yargs
			.command(addCommand)
			.command(getCommand)
			.command(rmCommand)
			.demandCommand(1, 'Specify a subcommand: add, get, rm'),
	handler: () => {},
});

/**
 * Build the authenticated cloud client from the resolved machine auth client, or
 * print a ready-to-read failure and return `null`. Every `blobs` subcommand is a
 * direct cloud round-trip, so each one starts here.
 * `resolveMachineAuthClient` settles the credential (OAuth cell or a configured
 * instance token) before returning, so `auth.state` is readable synchronously.
 * The blob client never re-resolves `/api/session` itself.
 */
async function connectCloud(): Promise<EpicenterClient | null> {
	const { data: auth, error: authError } =
		await machineAuth.resolveMachineAuthClient();
	if (authError) {
		fail(authError.message);
		return null;
	}
	if (auth.state.status === 'signed-out') {
		fail('not signed in: run `epicenter auth login` first');
		return null;
	}
	return createEpicenterClient({
		baseURL: auth.deployment.baseURL,
		fetch: (input, init) => auth.fetch(input, init),
	});
}

/**
 * Accept a bare BlobId or a pasted blob URL. A citation can be pasted back
 * verbatim to `get` or `rm` without extracting the id by hand.
 */
function parseBlobReference(input: string): Result<BlobId, string> {
	const direct = parseBlobId(input);
	if (direct) return Ok(direct);
	const fromUrl = input.match(/\/blobs\/(blob_[a-z0-9]{21})(?:[/?#]|$)/)?.[1];
	const parsed = parseBlobId(fromUrl);
	return parsed
		? Ok(parsed)
		: Err(`expected a BlobId or a blob URL containing one, got: ${input}`);
}

/**
 * Open a local file lazily as a BunFile typed by its extension. The bytes are
 * streamed by the SDK rather than copied into the CLI process first.
 */
async function readLocalFile(source: string): Promise<Result<Blob, string>> {
	const localPath = path.resolve(source);
	const file = Bun.file(localPath, { type: mime.getType(localPath) ?? '' });
	const { data: exists, error } = await tryAsync({
		try: () => file.exists(),
		catch: (cause) =>
			Err(`could not read ${source}: ${extractErrorMessage(cause)}`),
	});
	if (error !== null) return Err(error);
	if (!exists) return Err(`could not read ${source}: file does not exist`);
	return Ok(file);
}

/** Fetch a URL at the Bun CLI edge and adapt it to the portable Blob boundary. */
async function readHttpUrl(source: string): Promise<Result<Blob, string>> {
	const { data: response, error } = await tryAsync({
		try: () => fetch(source),
		catch: (cause) =>
			Err(`could not fetch ${source}: ${extractErrorMessage(cause)}`),
	});
	if (error !== null) return Err(error);
	if (!response.ok) {
		return Err(`could not fetch ${source}: HTTP ${response.status}`);
	}
	return tryAsync({
		try: () => response.blob(),
		catch: (cause) =>
			Err(`could not read ${source}: ${extractErrorMessage(cause)}`),
	});
}
