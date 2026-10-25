<!-- One capture file as Markdown. This view owns its text draft until each save answers. -->
<script lang="ts">
	import { captureTables } from '@epicenter/capture';
	import { readRow } from '@epicenter/folder/next';
	import { draft } from '@epicenter/svelte/folder-next';
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { untrack } from 'svelte';
	import { type Captures, capturePath, readCaptureBody } from '$lib/captures.svelte.js';
	import { copyText } from '$lib/download.js';
	import { getFolder } from '$lib/folder.js';
	import { confirmDelete } from '$lib/item-actions.js';

	let { captures, stem }: { captures: Captures; stem: string } = $props();
	const folder = getFolder();
	const path = untrack(() => capturePath(stem));
	const row = $derived(folder.tables.captures.row(stem));
	const source = $derived.by(() => {
		const file = folder.file(path);
		return file?.readError === null && typeof file.data === 'string' ? file.data : undefined;
	});
	const text = draft(
		() => (source ?? '').replace(/\r\n?/g, '\n'),
		(typing) => captures.track(folder.write(
			path,
			source?.includes('\r\n') ? typing.toWellFormed().replace(/\r?\n/g, '\r\n') : typing.toWellFormed(),
		)),
	);
	const parsed = $derived(readRow(text.text, captureTables.captures));
	const isDraft = $derived(parsed.issues === null && parsed.fields.draft === true);
	const body = $derived(parsed.issues === null ? parsed.body : undefined);
	const issues = $derived.by(() => {
		if (parsed.issues !== null) return parsed.issues;
		const reading = readCaptureBody(parsed);
		return reading.error === null ? [] : [{ message: reading.error.message }];
	});
	const selection = untrack(() => captures.opened?.focus);
	let finishing = $state(false);
	let refusal = $state<string | undefined>();

	function selectThought(node: HTMLTextAreaElement) {
		if (typeof selection !== 'object') return;
		node.focus();
		node.setSelectionRange(selection.start, selection.end);
	}
	function input(typing: string) {
		if (typing.includes('\0')) {
			refusal = 'A file cannot contain U+0000.';
			return;
		}
		refusal = undefined;
		text.set(typing);
	}
	async function finish() {
		if (finishing || !isDraft || !body?.trim()) return;
		finishing = true;
		const result = await captures.finishDraft(stem);
		finishing = false;
		if (result.error?.name === 'Refused') refusal = result.error.message;
	}
	async function copy(value: string, what: string) {
		if (await copyText(value)) toast.success(`${what} copied`);
		else toast.error('Could not copy. Select the text and copy it.');
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		<h1 class="mr-auto min-w-0 truncate font-mono text-sm">{path}</h1>
		{#if source !== undefined}
			{#if isDraft}
				<Button size="sm" disabled={finishing || !body?.trim()} onclick={() => void finish()}>
					{finishing ? 'Adding…' : 'Add capture'}
				</Button>
			{:else}
				<Button size="sm" variant="outline" disabled={issues.length > 0} onclick={() => void captures.open(stem, 'capture')}>Open as capture</Button>
			{/if}
			<Button size="sm" variant="ghost" onclick={() => void copy(text.text, 'File text')}>Copy file text</Button>
			<Button size="sm" variant="ghost" onclick={() => void confirmDelete(captures, stem)}>{isDraft ? 'Discard draft…' : 'Delete…'}</Button>
		{/if}
	</div>

	{#if isDraft}
		<p class="text-sm text-muted-foreground">This saved draft is its full Markdown file. Add capture finishes its writing and adds the Thoughts section. Ctrl or ⌘ + Enter adds it.</p>
	{/if}
	{#if refusal}
		<Alert.Root variant="destructive" aria-label="Not applied">
			<Alert.Title>That change was not made</Alert.Title>
			<Alert.Description>{refusal}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if source !== undefined}
		{#if issues.length > 0}
			<div class="rounded-md border bg-destructive/5 px-4 py-2 text-sm" role="status" aria-label="Needs repair">
				<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
					<Badge variant="destructive">Needs repair</Badge>
					This text does not read as a capture yet. It is checked as you type.
				</p>
				<ul class="space-y-0.5 text-muted-foreground">
					{#each issues as issue, index (index)}
						<li>{'line' in issue && issue.line !== undefined ? `Line ${issue.line}: ` : ''}{issue.message}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<Textarea
			aria-label="Contents of {path}"
			class="min-h-96 font-mono text-xs"
			spellcheck={false}
			readonly={finishing}
			aria-invalid={refusal !== undefined}
			bind:value={() => text.text, input}
			onkeydown={(event) => {
				if (!isDraft || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
				event.preventDefault();
				void finish();
			}}
			{@attach selectThought}
		/>
	{:else if row === undefined}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture is no longer here</Empty.Title>
				<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{:else if row.issues?.some((issue) => issue.kind === 'unreadable')}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This capture could not be read</Empty.Title>
				<Empty.Description>{row.issues.map((issue) => issue.message).join(' ')}</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button variant="outline" size="sm" onclick={() => folder.checkpoint()}>Try again</Button></Empty.Content>
		</Empty.Root>
	{:else}
		<Empty.Root role="alert">
			<Empty.Header>
				<Empty.Title>This file cannot be edited here</Empty.Title>
				<Empty.Description>It is not text. Nothing in it was changed.</Empty.Description>
			</Empty.Header>
		</Empty.Root>
	{/if}
</div>
