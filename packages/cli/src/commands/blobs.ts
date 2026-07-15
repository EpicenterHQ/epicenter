/**
 * `epicenter blobs`: trade a file that does not fit in git for a durable
 * content-addressed URL. The sha256 rides inside the URL, so the documents
 * that cite it are the only manifest; nothing is recorded anywhere else.
 *
 *   add <file|url>      upload the bytes (hash -> ticket -> presigned PUT
 *                       straight to the store) and print the URL; writes
 *                       nothing to disk
 *   ls                  list the current principal's stored blobs (the store is the index)
 *   get <sha256|url>    download one blob by content address to a file
 *
 * Every subcommand is a direct cloud round-trip built from the resolved machine
 * auth client (the persisted OAuth cell, or a configured instance token for a
 * self-hosted star); none route through a resident local process. See
 * `docs/adr/0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md`.
 *
 * Exit codes: 1 for a local problem (auth, reading a source file), 2 when the
 * cloud round-trip itself fails.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as machineAuth from '@epicenter/auth/node';
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
	describe: 'Archive a file or http(s) URL and print its content-addressed URL',
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

		// A URL source goes to the SDK as-is: it fetches the bytes once and takes
		// the content type from the response. A local file is read here and typed
		// by its extension; `--content-type` overrides either.
		const { data: source, error: readError } = HTTP_URL.test(argv.source)
			? Ok(argv.source)
			: await readLocalFile(argv.source);
		if (readError !== null) {
			fail(readError);
			return;
		}

		const { data: result, error: uploadError } = await epicenter.blobs.add(
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
		output(
			{ ref: result.ref, url: result.url, duplicate: result.duplicate },
			{ format: argv.format },
		);
	},
});

const lsCommand = cmd({
	command: 'ls',
	describe:
		"List the current principal's stored blobs (content address, size, upload time)",
	builder: (yargs) => yargs.options(formatOptions).strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: blobs, error } = await epicenter.blobs.list();
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}
		output(blobs, { format: argv.format });
	},
});

const getCommand = cmd({
	command: 'get <blob>',
	describe: 'Download a blob by content address and write it to a file',
	builder: (yargs) =>
		yargs
			.positional('blob', {
				type: 'string',
				demandOption: true,
				describe: 'A lowercase-hex sha256 content address, or a blob URL',
			})
			.option('output', {
				alias: 'o',
				type: 'string',
				describe: 'Destination path (default: <sha256>.<ext> in the cwd)',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const { data: sha256, error: parseError } = parseSha256(argv.blob);
		if (parseError !== null) {
			fail(parseError);
			return;
		}

		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: res, error } = await epicenter.blobs.get(sha256);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}

		const bytes = Buffer.from(await res.arrayBuffer());

		// The store enforces the hash on write, but a download can still be
		// truncated mid-flight; verify before we trust the bytes on disk.
		const actual = createHash('sha256').update(bytes).digest('hex');
		if (actual !== sha256) {
			fail(
				`downloaded bytes do not match their content address: expected ${sha256}, got ${actual}`,
				{ code: 2 },
			);
			return;
		}

		// Content type rides on the stored object (pinned at upload), so it names
		// the extension when the caller did not pick an output path.
		const contentType =
			res.headers.get('content-type') ?? 'application/octet-stream';
		const ext = mime.getExtension(contentType);
		const outputPath = path.resolve(
			argv.output ?? (ext ? `${sha256}.${ext}` : sha256),
		);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, bytes);

		output(
			{
				sha256,
				output: path.relative(process.cwd(), outputPath),
				size_bytes: bytes.byteLength,
				content_type: contentType,
			},
			{ format: argv.format },
		);
	},
});

// Removes the cloud object only; local files are yours to manage.
export const blobsCommand = cmd({
	command: 'blobs <subcommand>',
	describe: 'Archive and retrieve bytes in the content-addressed blob store',
	builder: (yargs) =>
		yargs
			.command(addCommand)
			.command(lsCommand)
			.command(getCommand)
			.demandCommand(1, 'Specify a subcommand: add, ls, get'),
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
 * Accept a bare content address or a pasted blob URL and return the
 * lowercase-hex sha256. The URL form matches the read-URL shape
 * (`.../blobs/<sha256>`), so a citation can be pasted back verbatim to `get`
 * without extracting the hash by hand.
 */
function parseSha256(input: string): Result<string, string> {
	if (/^[a-f0-9]{64}$/.test(input)) return Ok(input);
	const fromUrl = input.match(/\/blobs\/([a-f0-9]{64})(?:[/?#]|$)/);
	if (fromUrl?.[1]) return Ok(fromUrl[1]);
	return Err(
		`expected a 64-character lowercase-hex sha256 or a blob URL containing one, got: ${input}`,
	);
}

/**
 * Read a local file into a Blob typed by its extension (via `mime`; the SDK
 * defaults an untyped Blob to `application/octet-stream`). The error channel
 * is a ready-to-print message so the handler has one failure path.
 */
async function readLocalFile(source: string): Promise<Result<Blob, string>> {
	const localPath = path.resolve(source);
	const { data: bytes, error } = await tryAsync({
		try: () => fs.readFile(localPath),
		catch: (cause) =>
			Err(`could not read ${source}: ${extractErrorMessage(cause)}`),
	});
	if (error !== null) return Err(error);
	return Ok(
		new Blob([new Uint8Array(bytes)], { type: mime.getType(localPath) ?? '' }),
	);
}
