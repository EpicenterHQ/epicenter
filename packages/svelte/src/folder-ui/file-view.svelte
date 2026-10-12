<!--
	One open file other than the app's own item view: its exact text in a text
	session, or why it does not open, with its path, Copy path, and the name
	bar. A row file whose text is not a valid row shows its issues, read live
	from what is typed, and is repaired here.

	Mount one per open item, keyed by it: the view never changes sessions.
-->
<script lang="ts" module>
	import type { TextSession } from '../edit-session.svelte.js';

	/** What FileView shows for an open path. An app's own item types carry more fields. */
	export type FileViewItem =
		| { readonly kind: 'loading' }
		| { readonly kind: 'failed'; readonly message: string }
		| { readonly kind: 'text'; readonly session: TextSession }
		| { readonly kind: 'binary' | 'tooLarge'; readonly size: number };
</script>

<script lang="ts">
	import { type PreparedFolderTable, parseRow } from '@epicenter/folder';
	import { basename, dirname, withFileNewlines } from '@epicenter/folder/file-browser';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import FileIcon from '@lucide/svelte/icons/file';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Snippet } from 'svelte';
	import SaveBar from '../save-bar.svelte';
	import { copyPath, fileDetails } from './file-actions.js';
	import FileNameBar from './file-name-bar.svelte';

	let {
		path,
		item,
		children,
		row,
		notice,
		backLabel = 'Back',
		onBack,
		onRetry,
		onReloadTheirs,
		onKeepMine,
		canKeepMine = () => true,
		onRename,
		onDelete,
	}: {
		path: string;
		/** The open item, or undefined when `children` shows it. */
		item: FileViewItem | undefined;
		/** The body for an item this view does not show itself, such as audio. */
		children?: Snippet;
		/**
		 * The table whose row this file is, when it is one. Its text is checked
		 * as a row while it is typed. `noun` names the row to a person, and
		 * `onOpenAsRow` offers the app's own view once the text reads.
		 */
		row?: { table: PreparedFolderTable; noun: string; onOpenAsRow?: () => void };
		/** Shown above the text when it has no issues to repair. */
		notice?: Snippet;
		/** Names where `onBack` goes, such as "Back to todos". */
		backLabel?: string;
		/** Shown on narrow screens, where the list and the file take turns. */
		onBack?: () => void;
		/** Read the file again after it failed to open. */
		onRetry: () => void;
		onReloadTheirs: (session: TextSession) => Promise<string | undefined>;
		onKeepMine: (session: TextSession) => Promise<string | undefined>;
		/** False when the file cannot be restored, so only Discard is offered. */
		canKeepMine?: (session: TextSession) => boolean;
		/** Returns a problem to show, or undefined when the rename is done. */
		onRename: (name: string) => Promise<string | undefined>;
		onDelete: () => void;
	} = $props();

	const name = $derived(basename(path));
	const directory = $derived(dirname(path));
	/** Why the text is not a row yet, read live from what is typed. */
	const issues = $derived.by(() => {
		if (row === undefined || item?.kind !== 'text') return undefined;
		return parseRow(row.table, item.session.draft).error ?? undefined;
	});
</script>

<section class="flex h-full min-h-0 flex-col overflow-y-auto" aria-label="File">
	<div class="flex shrink-0 items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label={backLabel} onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		<FileIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<div class="min-w-0 flex-1">
			<h2 class="truncate text-sm font-medium">{name}</h2>
			<p class="truncate font-mono text-xs text-muted-foreground">{path}</p>
		</div>
		{#if row?.onOpenAsRow && item?.kind === 'text'}
			<Button
				size="sm"
				variant="outline"
				disabled={issues !== undefined}
				tooltip={issues === undefined ? undefined : 'Fix the text first'}
				onclick={row.onOpenAsRow}
			>
				Open as {row.noun}
			</Button>
		{/if}
		<Button variant="ghost" size="icon-sm" tooltip="Copy path" aria-label="Copy path" onclick={() => void copyPath(path)}>
			<CopyIcon />
		</Button>
	</div>

	{#if item === undefined}
		{@render children?.()}
	{:else if item.kind === 'loading'}
		<Loading class="flex-1" label="Opening {name}…" />
	{:else if item.kind === 'failed'}
		<Empty.Root class="flex-1">
			<Empty.Media><TriangleAlertIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>Could not open this file</Empty.Title>
			<Empty.Description>{item.message}</Empty.Description>
			<Button variant="outline" size="sm" onclick={onRetry}>Try again</Button>
		</Empty.Root>
	{:else if item.kind === 'text'}
		{@const session = item.session}
		<SaveBar
			save={session.state}
			onRetry={() => session.retry()}
			onReloadTheirs={() => onReloadTheirs(session)}
			gone={!canKeepMine(session)}
			onKeepMine={canKeepMine(session) ? () => onKeepMine(session) : undefined}
		/>
		{#if issues}
			<div class="shrink-0 border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a {row?.noun} yet. Fix it here; it saves as you type.
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each issues as issue, index (index)}
						<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
					{/each}
				</ul>
			</div>
		{:else if notice}
			<div class="shrink-0 px-4 pt-2 text-xs text-muted-foreground">{@render notice()}</div>
		{/if}
		<div class="flex min-h-48 flex-1 flex-col px-3 py-3 sm:px-4">
			<Textarea
				class="min-h-0 flex-1 field-sizing-fixed resize-none font-mono text-xs"
				aria-label="Contents of {name}"
				spellcheck={false}
				disabled={session.locked}
				bind:value={
					() => session.draft.replace(/\r\n?/g, '\n'),
					(text) => session.input(withFileNewlines(text, session.draft))
				}
			/>
		</div>
	{:else}
		<Empty.Root class="flex-1">
			<Empty.Media><FileIcon class="size-8 text-muted-foreground" /></Empty.Media>
			<Empty.Title>{fileDetails(name, item.size)}</Empty.Title>
			<Empty.Description>
				{item.kind === 'binary'
					? 'This file is not text, so it is listed here but not opened for editing.'
					: 'This text file is larger than 1 MB, so it is not opened in the editor.'}
				Rename, delete, and the terminal still work on it.
			</Empty.Description>
		</Empty.Root>
	{/if}

	<FileNameBar prefix={directory === '' ? '' : `${directory}/`} {name} {onRename} {onDelete} />
</section>
