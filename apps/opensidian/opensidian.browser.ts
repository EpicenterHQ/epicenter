/**
 * Opensidian browser composition: the one boot call (ADR-0088/ADR-0094).
 *
 * `toWorkspaceConnection` reads `auth.state` once: signed out selects local
 * storage, while signed in selects the principal's synchronized storage.
 * `compose` adds
 * browser-only filesystem, search, shell, and action surfaces on top of
 * whichever root wiring the connection chose:
 *
 *  1. workspace root doc (tables + KV)
 *  2. local storage (+ cloud sync when signed in) for root
 *  3. runtime storage (+ sync when signed in) around per-file content child docs
 *  4. filesystem, sqlite index, bash, and action registry
 *
 * The bundle's `wipe()` drops every principal-scoped IDB database (or the bare
 * guid family when signed out); `Symbol.dispose` tears down the root and
 * cached child Y.Docs without touching local storage.
 */

import type { SyncAuthClient } from '@epicenter/auth';
import {
	attachYjsFileSystem,
	createSqliteIndex,
	type FileId,
} from '@epicenter/filesystem';
import { toWorkspaceConnection } from '@epicenter/svelte/auth';
import {
	type ComposeContext,
	defineActions,
	defineMutation,
	defineQuery,
} from '@epicenter/workspace';
import { Bash } from 'just-bash';
import Type from 'typebox';
import { Ok } from 'wellcrafted/result';
import { opensidianWorkspace } from './opensidian.js';

export function openOpensidianBrowser({ auth }: { auth: SyncAuthClient }) {
	function compose(workspace: ComposeContext<typeof opensidianWorkspace>) {
		const { ydoc, tables } = workspace;
		// The runtime bumps `files.updatedAt` on local body edits (declared via
		// `touch` on the files table), so these openers read/write the content
		// doc directly; no hand-wired recency observer.
		const fileContent = {
			async read(fileId: FileId) {
				using handle = tables.files.docs.content.open(fileId);
				await handle.whenLoaded;
				return handle.read();
			},
			async write(fileId: FileId, text: string) {
				using handle = tables.files.docs.content.open(fileId);
				await handle.whenLoaded;
				handle.write(text);
			},
			async append(fileId: FileId, text: string) {
				using handle = tables.files.docs.content.open(fileId);
				await handle.whenLoaded;
				handle.appendText(text);
				return handle.read();
			},
		};
		const fs = attachYjsFileSystem(ydoc, tables.files, fileContent);
		const sqliteIndex = createSqliteIndex({
			readContent: fileContent.read,
			index: fs.index,
		})({
			tables,
		});
		const sqliteIndexExports = sqliteIndex.exports;
		const bash = new Bash({ fs, cwd: '/' });
		const actions = defineActions({
			...workspace.actions,
			files_search: defineQuery({
				title: 'Search Notes',
				description:
					'Search notes by content using full-text search. Returns matching file paths and content snippets.',
				input: Type.Object({
					query: Type.String({ description: 'The search query string' }),
				}),
				handler: async ({ query }) =>
					Ok(await sqliteIndexExports.search(query)),
			}),
			files_read: defineQuery({
				title: 'Read File',
				description:
					'Read the full content of a file by its absolute path (e.g. "/notes/meeting.md").',
				input: Type.Object({
					path: Type.String({
						description: 'Absolute file path starting with /',
					}),
				}),
				handler: async ({ path }) => {
					const content = await fs.readFile(path);
					const MAX_LENGTH = 50_000;
					if (content.length > MAX_LENGTH) {
						return Ok({
							content: content.slice(0, MAX_LENGTH),
							truncated: true,
							totalLength: content.length,
							note: `Content truncated at ${MAX_LENGTH} chars. Use bash head/tail for specific sections.`,
						});
					}
					return Ok({ content, truncated: false });
				},
			}),
			files_list: defineQuery({
				title: 'List Directory',
				description:
					'List files and folders in a directory. Use "/" for the root.',
				input: Type.Object({
					path: Type.Optional(
						Type.String({ description: 'Directory path. Defaults to "/"' }),
					),
				}),
				handler: async ({ path }) => {
					const entries = await fs.readdir(path ?? '/');
					return Ok({ entries });
				},
			}),
			files_write: defineMutation({
				title: 'Write File',
				description:
					'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
				input: Type.Object({
					path: Type.String({ description: 'Absolute file path' }),
					content: Type.String({ description: 'The content to write' }),
				}),
				handler: async ({ path, content }) => {
					await fs.writeFile(path, content);
					return Ok({ success: true, path });
				},
			}),
			files_create: defineMutation({
				title: 'Create File',
				description: 'Create a new empty file at the given path.',
				input: Type.Object({
					path: Type.String({
						description: 'Absolute file path for the new file',
					}),
				}),
				handler: async ({ path }) => {
					await fs.writeFile(path, '');
					return Ok({ success: true, path });
				},
			}),
			files_delete: defineMutation({
				title: 'Delete File',
				description: 'Delete a file or directory at the given path.',
				input: Type.Object({
					path: Type.String({ description: 'Absolute path to delete' }),
				}),
				handler: async ({ path }) => {
					await fs.rm(path);
					return Ok({ success: true, path });
				},
			}),
			files_move: defineMutation({
				title: 'Move/Rename File',
				description: 'Move or rename a file from one path to another.',
				input: Type.Object({
					src: Type.String({ description: 'Current file path' }),
					dst: Type.String({ description: 'New file path' }),
				}),
				handler: async ({ src, dst }) => {
					await fs.mv(src, dst);
					return Ok({ success: true, from: src, to: dst });
				},
			}),
			files_mkdir: defineMutation({
				title: 'Create Directory',
				description: 'Create a new directory at the given path.',
				input: Type.Object({
					path: Type.String({ description: 'Absolute directory path' }),
				}),
				handler: async ({ path }) => {
					await fs.mkdir(path);
					return Ok({ success: true, path });
				},
			}),
			bash_exec: defineMutation({
				title: 'Execute Bash Command',
				description:
					'Execute a bash command against the virtual filesystem. Supports standard Unix commands (ls, cat, grep, echo, etc.).',
				input: Type.Object({
					command: Type.String({
						description: 'The bash command to execute',
					}),
				}),
				handler: async ({ command }) => {
					const result = await bash.exec(command);
					return Ok({
						stdout: result.stdout,
						stderr: result.stderr,
						exitCode: result.exitCode,
					});
				},
			}),
		});

		return {
			sqliteIndex: sqliteIndexExports,
			fs,
			bash,
			actions,
			[Symbol.dispose]() {
				sqliteIndex[Symbol.dispose]();
			},
		};
	}

	return opensidianWorkspace.connect(toWorkspaceConnection(auth), compose);
}

export type OpensidianBrowser = ReturnType<typeof openOpensidianBrowser>;
