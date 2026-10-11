<!--
	One capture file as its exact Markdown, frontmatter included. It saves as
	typed, valid or not, so a file that is not a valid capture is repaired
	here. What keeps it from reading as a capture is read live from the text;
	once nothing does, Open as capture shows its text and thoughts. The parent
	keys this view by the open item.
-->
<script lang="ts">
	import { captureBody, captureDefinition, fromTextarea, toTextarea } from '@epicenter/capture';
	import { parseRow } from '@epicenter/folder';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { untrack } from 'svelte';
	import type { Captures, Opened } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import { backToTimeline, confirmDelete, openItem } from '$lib/item-actions.js';
	import SaveBar from '@epicenter/svelte/save-bar';

	let {
		captures,
		item,
	}: {
		captures: Captures;
		/** The open file. The parent keys this view by it. */
		item: Extract<Opened, { kind: 'text' }>;
	} = $props();

	// The view is keyed by the item, so it never changes for this view.
	const { session, stem } = untrack(() => item);

	/** Why the text is not a capture yet: each with its line when it has one. */
	const issues = $derived.by((): readonly { line?: number; message: string }[] => {
		const { data: row, error } = parseRow(captureDefinition.tables.captures, session.draft);
		if (error !== null) return error;
		const { error: refusal } = captureBody.decode(row.body);
		return refusal === null ? [] : [{ message: refusal.message }];
	});

	async function copy() {
		if (await copyText(session.draft)) toast.success('File text copied');
		else toast.error('Could not copy. Select the text and copy it.');
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => void backToTimeline(captures)}>Back to timeline</Button>
		<h1 class="mr-auto min-w-0 truncate font-mono text-sm">{session.path}</h1>
		<Button
			size="sm"
			variant="outline"
			disabled={issues.length > 0}
			onclick={() => void openItem(captures, stem, 'capture')}>Open as capture</Button
		>
		<Button size="sm" variant="ghost" onclick={copy}>Copy file text</Button>
		<Button size="sm" variant="ghost" disabled={captures.fenced} onclick={() => confirmDelete(captures, '')}>Delete…</Button>
	</div>

	<SaveBar
		save={session.state}
		review={session.review}
		class="rounded-md border"
		onRetry={() => session.retry()}
		onResolve={(choices) => captures.resolve(session, choices)}
	/>

	{#if issues.length > 0}
		<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This text does not read as a capture yet. Fix it here; it saves as you type.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<Textarea
		aria-label="Contents of {session.path}"
		class="min-h-96 font-mono text-xs"
		spellcheck={false}
		readonly={session.locked}
		bind:value={
			() => toTextarea(session.draft),
			(text) =>
				session.input(
					fromTextarea(session.draft, text, session.draft.includes('\r\n') ? '\r\n' : '\n'),
				)
		}
	/>
</div>
