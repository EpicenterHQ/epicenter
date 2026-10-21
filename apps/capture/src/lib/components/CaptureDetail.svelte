<!--
	One completed capture: the folder's edit of its
	row, the capture as stored with what is typed over it, which the
	timeline's reads keep current too, so the two never disagree. A thought
	command saves at once; the capture text saves a second after the last
	keystroke, even after this view goes away. "Edit
	as text" opens the file's exact Markdown instead, for the whole capture or
	one thought. A thought not added yet is this view's input: leaving the
	capture clears it. The parent keys this view by the capture.

	When the body stops reading as text and thoughts (a version read again
	with two Thoughts headings, say), the controls go away rather than show
	values the file does not have, and Edit as text is the way to repair it.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createFileEdit } from '@epicenter/svelte/edits';
	import { createQuery } from '@tanstack/svelte-query';
	import { tick, untrack } from 'svelte';
	import { createCaptureActions } from '$lib/capture-actions.svelte.js';
	import { type Captures, capturePath, describeFailure, instantOf, readCaptureBody } from '$lib/captures.svelte.js';
	import { copyText, downloadText } from '$lib/download.js';
	import { confirmDelete } from '$lib/item-actions.js';

	let {
		captures,
		stem,
	}: {
		captures: Captures;
		/** The capture shown. The parent keys this view by it. */
		stem: string;
	} = $props();

	// The view is keyed by the capture, so neither changes for this view.
	const path = untrack(() => capturePath(stem));
	/** The capture's commands, typing into the folder's edit of it, which every view shows. */
	const fileEdit = untrack(() => createFileEdit(captures.folder.tables.captures.edit(stem)));
	const actions = untrack(() => createCaptureActions(fileEdit));
	/** Opened right after Add: focus goes to Add a thought. */
	const focusNewThought = untrack(() => captures.opened?.focus === 'new-thought');
	// The folder watches no directory: this read, polled while the view
	// shows, is how an edit made outside this page reaches it.
	createQuery(() => captures.readQuery(fileEdit));
	const status = $derived(fileEdit.readStatus);
	const stored = $derived(fileEdit.markdown?.issues === null ? fileEdit.markdown : undefined);
	const pending = $derived(fileEdit.pending);
	/** The body as text and thoughts, or why it cannot be edited here. */
	const reading = $derived(stored === undefined ? undefined : readCaptureBody(stored));
	const text = $derived(reading?.data?.text ?? '');
	const thoughts = $derived(reading?.data?.thoughts ?? []);
	const capturedAt = $derived(instantOf(stored?.fields.capturedAt));
	/** Edits wait while closing and while this capture is deleted. */
	const locked = $derived(captures.isLocked(stem));
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	/** A thought typed and not added yet. */
	let newThought = $state('');
	let newThoughtField = $state<HTMLTextAreaElement | null>(null);
	let thoughtList = $state<HTMLOListElement>();

	$effect(() => {
		if (focusNewThought) newThoughtField?.focus();
	});

	// Engines without content-sized fields fall back to this many rows.
	const rowsFor = (value: string) => Math.min(12, Math.max(3, value.split('\n').length + 1));

	function submitOnModEnter(event: KeyboardEvent & { currentTarget: HTMLTextAreaElement }) {
		if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	/** Put focus on a thought's menu, or the nearest one, or on Add a thought when there are none. */
	async function focusThought(index: number) {
		await tick();
		const menus = thoughtList?.querySelectorAll<HTMLElement>('[data-thought-actions]');
		const menu = menus?.[Math.min(index, menus.length - 1)];
		(menu ?? newThoughtField)?.focus();
	}

	/** What runs as the open menu closes, instead of its focus return: focus its action moved, or the view it opens. */
	let afterMenu: (() => void) | undefined;
	function onMenuClosed(event: Event) {
		if (!afterMenu) return;
		event.preventDefault();
		afterMenu();
		afterMenu = undefined;
	}

	async function copy(value: string, what: string) {
		if (await copyText(value)) toast.success(`${what} copied`);
		else toast.error('Could not copy. Select the text and copy it.');
	}

	/** Download the file as saved, once the edit held here is saved. */
	async function download() {
		await fileEdit.save();
		if (fileEdit.pending !== undefined) {
			toast.error('Could not download this capture', { description: 'Your edit is not saved yet. Save it again, then download.' });
			return;
		}
		const saved = await captures.folder.tables.captures.get(stem);
		if (saved.error !== null) toast.error('Could not download this capture', { description: describeFailure(saved.error) });
		else if (saved.data === undefined) toast.error('Could not download this capture', { description: 'It is no longer here.' });
		else downloadText(`${stem}.md`, saved.data.text);
	}

	function confirmDiscard() {
		confirmationDialog.open({
			title: 'Discard your edit?',
			description: `Copy anything you need first. ${path} keeps what was last saved.`,
			confirm: { text: 'Discard edit', variant: 'destructive' },
			onConfirm: () => void fileEdit.discard(),
		});
	}

	/** Copy pending input exactly, even when a deleted file no longer has a readable row. */
	const unsavedText = $derived.by(() => {
		if (pending !== undefined) return pending.text;
		return fileEdit.markdown?.body ?? '';
	});
	const conflict = $derived(pending?.error?.name === 'Conflict' ? pending.error : undefined);
	const savedConflictSource = $derived.by(() => {
		if (conflict === undefined) return undefined;
		if (conflict.current === null) return '(deleted)';
		if (typeof conflict.current === 'string') return conflict.current;
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(conflict.current);
		} catch {
			return '(binary file)';
		}
	});

	function confirmDeleteThought(thought: string, index: number, shown: readonly string[]) {
		confirmationDialog.open({
			title: 'Delete this thought?',
			description: thought.length > 300 ? `${thought.slice(0, 300)}…` : thought,
			confirm: { text: 'Delete thought', variant: 'destructive' },
			onConfirm: () => {
				if (actions.deleteThought(index, shown)) void focusThought(index);
			},
		});
	}
</script>

{#snippet saveFailed()}
	{#if pending?.error && !pending.saving}
		<Alert.Root variant="destructive" aria-label="Not saved">
			<Alert.Title>Your edit is not saved</Alert.Title>
			<Alert.Description>{describeFailure(pending.error)} Your edit is still here.</Alert.Description>
			{#if conflict !== undefined}
				<details class="mt-2"><summary>Compare sources</summary><p>Saved source</p><pre class="max-h-40 overflow-auto whitespace-pre-wrap">{savedConflictSource}</pre><p>Your source</p><pre class="max-h-40 overflow-auto whitespace-pre-wrap">{unsavedText}</pre></details>
			{/if}
			<div class="mt-2 flex flex-wrap gap-2 text-foreground">
				{#if conflict !== undefined}
					<Button size="sm" variant="outline" onclick={() => void fileEdit.resolveConflict('current')}>Use saved file</Button>
					<Button size="sm" variant="outline" onclick={() => void fileEdit.resolveConflict('draft')}>Replace saved file</Button>
				{:else}
					<Button size="sm" variant="outline" onclick={() => void fileEdit.save()}>Save again</Button>
				{/if}
				<Button size="sm" variant="outline" onclick={() => copy(unsavedText, 'Your text')}>Copy your text</Button>
				<Button size="sm" variant="ghost" onclick={confirmDiscard}>Discard edit</Button>
			</div>
		</Alert.Root>
	{/if}
{/snippet}

{#if reading?.data?.draft}
	<div class="flex flex-col gap-4">
		<Button variant="outline" size="sm" class="self-start" onclick={() => captures.leave()}>Back to timeline</Button>
		<Alert.Root>
			<Alert.Title>This file is a draft</Alert.Title>
			<Alert.Description>Edit its Markdown as text to continue writing or finish it.</Alert.Description>
			<div class="mt-2"><Button size="sm" onclick={() => captures.open(stem, 'text')}>Edit as text</Button></div>
		</Alert.Root>
		{@render saveFailed()}
	</div>
{:else if reading === undefined}
	<div class="flex flex-col gap-4">
		<div>
			<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		</div>
		{#if fileEdit.markdown?.issues}
			{@const unreadable = status.known === 'not-text'}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>{unreadable ? 'This capture could not be read' : 'This file does not read as a capture'}</Empty.Title>
					<Empty.Description>{fileEdit.markdown.issues.map((issue) => issue.message).join(' ')}</Empty.Description>
				</Empty.Header>
				{#if !unreadable}
					<Empty.Content>
						<Button size="sm" onclick={() => captures.open(stem, 'text')}>Edit as text</Button>
					</Empty.Content>
				{/if}
			</Empty.Root>
		{:else if status.known === 'missing'}
			{#if pending}
				<!-- Deleted in another tab while an edit was held: restoring it requires explicit conflict resolution. -->
				<Alert.Root aria-label="Edit kept">
					<Alert.Title>This capture was deleted, and your edit is still here</Alert.Title>
					<Alert.Description>
						{#if pending.error}<p>Not saved: {describeFailure(pending.error)}</p>{/if}
						<p>Your source remains available. Choose to replace the saved file after a conflict, copy it, or discard it.</p>
					</Alert.Description>
					<div class="mt-2 flex flex-wrap gap-2 text-foreground">
						{#if conflict !== undefined}
							<Button size="sm" variant="outline" onclick={() => void fileEdit.resolveConflict('current')}>Use saved file</Button>
							<Button size="sm" variant="outline" onclick={() => void fileEdit.resolveConflict('draft')}>Replace saved file</Button>
						{:else}
							<Button size="sm" variant="outline" onclick={() => void fileEdit.save()}>Save again</Button>
						{/if}
						<Button size="sm" variant="outline" onclick={() => copy(unsavedText, 'Your text')}>Copy your text</Button>
						<Button size="sm" variant="ghost" onclick={confirmDiscard}>Discard edit</Button>
					</div>
				</Alert.Root>
			{:else}
				<Empty.Root role="alert">
					<Empty.Header>
						<Empty.Title>This capture is no longer here</Empty.Title>
						<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
					</Empty.Header>
				</Empty.Root>
			{/if}
		{:else if status.error}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This capture could not be read</Empty.Title>
					<Empty.Description>{status.error.message}</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button variant="outline" size="sm" onclick={() => void fileEdit.read()}>Try again</Button>
				</Empty.Content>
			</Empty.Root>
		{:else}
			<Loading label="Opening…" />
		{/if}
	</div>
{:else}
<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		<h1 class="mr-auto text-lg font-semibold tracking-tight">
			{#if capturedAt}
				<time datetime={capturedAt.toISOString()}>{when.format(capturedAt)}</time>
			{:else}
				Capture with no date
			{/if}
		</h1>
		<Button variant="outline" size="sm" onclick={() => captures.open(stem, 'text')}>Edit as text</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" aria-label="More capture actions">More</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item onclick={() => copy(text, 'Capture text')}>Copy capture text</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => void download()}>Download file</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" disabled={locked} onclick={() => void confirmDelete(captures, stem)}>Delete capture…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<p class="text-xs text-muted-foreground" role="status" aria-label="Save status">
		{#if fileEdit.pending}
			{#if fileEdit.pending.error && !fileEdit.pending.saving}
				Not saved
			{:else}
				Saving…
			{/if}
		{:else}
			Saved to {path}
		{/if}
	</p>

	{@render saveFailed()}

	{#if actions.refusal}
		<Alert.Root aria-label="Not applied">
			<Alert.Title>Not applied</Alert.Title>
			<Alert.Description>{actions.refusal}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if reading.error}
		<Alert.Root variant="destructive" aria-label="Needs repair">
			<Alert.Title>This capture cannot be edited as text and thoughts</Alert.Title>
			<Alert.Description>
				<p>{reading.error.message}</p>
				<p>Nothing was changed. Edit its Markdown as text to repair it.</p>
			</Alert.Description>
			<div class="mt-2 text-foreground">
				<Button size="sm" onclick={() => captures.open(stem, 'text')}>Edit as text</Button>
			</div>
		</Alert.Root>

	{:else}
		<div class="flex flex-col gap-8">
			<Field.Field>
				<Field.Label for="capture-text">Capture text</Field.Label>
				<Textarea
					id="capture-text"
					readonly={locked}
					bind:value={() => text, (typed) => actions.inputText(typed)}
					rows={rowsFor(text)}
					class="max-h-96 resize-y leading-relaxed"
					placeholder="Write here…"
				/>
				<p class="text-sm text-muted-foreground">Changes that cannot be applied return to the current text. Edit as text to write unfinished Markdown.</p>
			</Field.Field>

			<section class="flex flex-col gap-3" aria-label="Capture thoughts">
				<h2 class="font-medium">
					Thoughts
					{#if thoughts.length}<span class="font-normal text-muted-foreground">{thoughts.length}</span>{/if}
				</h2>

				{#if thoughts.length}
					{@const shown = thoughts}
					<ol bind:this={thoughtList} aria-label="Thoughts" class="list-decimal divide-y border-y pl-6 marker:text-muted-foreground">
						{#each shown as thought, index (index)}
							<li class="py-1 pl-1">
								<div class="flex items-start gap-2">
									<p class="min-w-0 flex-1 whitespace-pre-wrap break-words py-1.5 leading-relaxed {thought ? '' : 'text-muted-foreground'}">{thought || 'Empty thought'}</p>
									<DropdownMenu.Root>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Button {...props} variant="ghost" size="sm" class="text-muted-foreground" aria-label="Thought actions" data-thought-actions>Actions</Button>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content align="end" class="w-48" onCloseAutoFocus={onMenuClosed}>
											<DropdownMenu.Item onclick={() => {
												const range = actions.locateThought(index, shown);
												// The text view opens once the menu has closed, and takes focus.
												if (range !== undefined) afterMenu = () => captures.open(stem, 'text', range);
											}}>Edit as text</DropdownMenu.Item>
											<DropdownMenu.Item disabled={locked || index === 0} onclick={() => {
												if (actions.swapThoughts(index, index - 1, shown)) afterMenu = () => void focusThought(index - 1);
											}}>Move up</DropdownMenu.Item>
											<DropdownMenu.Item disabled={locked || index === shown.length - 1} onclick={() => {
												if (actions.swapThoughts(index, index + 1, shown)) afterMenu = () => void focusThought(index + 1);
											}}>Move down</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item onclick={() => copy(thought, 'Thought')}>Copy text</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item variant="destructive" disabled={locked} onclick={() => confirmDeleteThought(thought, index, shown)}>Delete thought…</DropdownMenu.Item>
										</DropdownMenu.Content>
									</DropdownMenu.Root>
								</div>
							</li>
						{/each}
					</ol>
				{/if}

				<form
					onsubmit={(event) => {
						event.preventDefault();
						if (actions.addThought(newThought)) newThought = '';
						newThoughtField?.focus();
					}}
					class="flex flex-col gap-2"
				>
					<Field.Field>
						<Field.Label for="new-thought">Add a thought</Field.Label>
						<Textarea
							id="new-thought"
							bind:ref={newThoughtField}
							readonly={locked}
							bind:value={newThought}
							onkeydown={submitOnModEnter}
							rows={2}
							class="leading-relaxed"
							placeholder="Write a line or paragraph…"
						/>
					</Field.Field>
					<div class="flex items-center justify-between gap-3">
						<p class="text-xs text-muted-foreground">
							{#if newThought !== ''}
								Not added yet. Leaving this capture clears it.
							{:else if thoughts.length}
								Ctrl or ⌘ + Enter adds it after the last thought.
							{:else}
								Thoughts you add are saved in this capture, under its Thoughts heading.
							{/if}
						</p>
						<Button type="submit" size="sm" disabled={locked}>Add thought</Button>
					</div>
				</form>

				{#if reading.data?.hasOtherContent}
					<p class="text-muted-foreground">This file has more Markdown after its thoughts. It is kept as it is; Edit as text shows it.</p>
				{/if}
			</section>
		</div>
	{/if}
</div>
{/if}

{#if newThought !== '' && (!reading?.data || reading.data.draft)}
	<!-- Typed here and not in the file: kept visible to copy, since Add a thought cannot show it now. -->
	<Field.Field>
		<Field.Label>Thought not added</Field.Label>
		<Textarea aria-label="Thought not added" readonly value={newThought} rows={rowsFor(newThought)} />
		<div>
			<Button variant="outline" size="sm" onclick={() => copy(newThought, 'Text')}>Copy text</Button>
		</div>
	</Field.Field>
{/if}
