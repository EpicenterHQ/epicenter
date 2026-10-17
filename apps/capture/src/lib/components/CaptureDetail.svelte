<!--
	One capture as its text and thoughts. The view reads the capture listing
	narrowed to this capture, so it never disagrees with the timeline, and
	shows the capture's edit over it until the edit's saves land. A thought
	command saves at once; the capture text saves a second after the last
	keystroke, when the person leaves it, and when this view goes away. "Edit
	as text" opens the file's exact Markdown instead. The parent keys this
	view by the capture.

	When the body stops reading as text and thoughts (a version read again
	with two Thoughts headings, say), the controls go away rather than show
	values the file does not have, and Edit as text is the way to repair it.
-->
<script lang="ts">
	import { captureBody, captureDefinition } from '@epicenter/capture';
	import { formatRow, rowPath } from '@epicenter/folder';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { onDestroy, tick, untrack } from 'svelte';
	import { type Captures, instantOf } from '$lib/captures.svelte.js';
	import { copyText, downloadText } from '$lib/download.js';
	import { confirmDelete } from '$lib/item-actions.js';
	import ThoughtEditForm from './ThoughtEditForm.svelte';

	let {
		captures,
		stem,
		focusNewThought = false,
	}: {
		captures: Captures;
		/** The capture shown. The parent keys this view by it. */
		stem: string;
		/** The capture was just added: the next thing to type is a thought. */
		focusNewThought?: boolean;
	} = $props();

	// The view is keyed by the capture, so neither changes for this view.
	const path = untrack(() => rowPath(captures.folder.tables.captures.name, stem));
	const form = untrack(() => captures.formOf(stem));
	const entry = createQuery(() =>
		captures.rowsQuery((listing) => listing.find((found) => found.stem === stem)),
	);
	const stored = $derived(entry.data?.result.error === null ? entry.data.result.data : undefined);
	/** The row shown: its body the edit not saved yet, or the file's. */
	const row = $derived(
		stored === undefined ? undefined : { fields: stored.row.fields, body: form.body ?? stored.row.body },
	);
	// The capture text typed saves after a pause, and when the person leaves
	// it; the draft outlives the view, so send it now.
	onDestroy(() => void form.flush());
	/** The body as text and thoughts, or why it cannot be edited here. */
	const reading = $derived(row === undefined ? undefined : captureBody.decode(row.body));
	const text = $derived(reading?.data?.text ?? '');
	const thoughts = $derived(reading?.data?.thoughts ?? []);
	const capturedAt = $derived(instantOf(row?.fields.capturedAt));
	/** Edits wait while closing and while this capture is deleted. */
	const locked = $derived(captures.fenced || captures.isDeleting(path));
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	let newThoughtField = $state<HTMLTextAreaElement | null>(null);
	let thoughtList = $state<HTMLOListElement>();

	// The new capture opens before its creation is reported, so this follows the prop.
	$effect(() => {
		if (focusNewThought) untrack(() => newThoughtField)?.focus();
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

	/** Where focus goes when the open menu closes, when its action moved things. */
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

	function download() {
		if (row === undefined) return;
		const { data: file, error } = formatRow(captureDefinition.tables.captures, row);
		if (error !== null) toast.error('Could not download this capture', { description: error.message });
		else downloadText(`${stem}.md`, file);
	}

	function confirmDeleteThought(thought: string, index: number, shown: readonly string[]) {
		confirmationDialog.open({
			title: 'Delete this thought?',
			description: thought.length > 300 ? `${thought.slice(0, 300)}…` : thought,
			confirm: { text: 'Delete thought', variant: 'destructive' },
			onConfirm: () => {
				if (form.deleteThought(index, shown)) void focusThought(index);
			},
		});
	}
</script>

{#if reading === undefined}
	<div class="flex flex-col gap-4">
		<div>
			<Button variant="outline" size="sm" onclick={() => captures.leave()}>Back to timeline</Button>
		</div>
		{#if entry.data?.result.error}
			{@const error = entry.data.result.error}
			<Empty.Root role="alert">
				<Empty.Header>
					{#if error.name === 'InvalidRow'}
						<Empty.Title>This file does not read as a capture</Empty.Title>
						<Empty.Description>{error.issues.map((issue) => issue.message).join(' ')}</Empty.Description>
					{:else}
						<Empty.Title>This capture could not be read</Empty.Title>
						<Empty.Description>{error.message}</Empty.Description>
					{/if}
				</Empty.Header>
				<Empty.Content>
					{#if error.name === 'InvalidRow'}
						<Button size="sm" onclick={() => captures.open(stem, 'text')}>Edit as text</Button>
					{:else}
						<Button variant="outline" size="sm" onclick={() => void entry.refetch()}>Try again</Button>
					{/if}
				</Empty.Content>
			</Empty.Root>
		{:else if entry.isSuccess}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This capture is no longer in the folder</Empty.Title>
					<Empty.Description>It was deleted, here or by another program.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else if entry.isError}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>The captures folder could not be read</Empty.Title>
					<Empty.Description>{entry.error.message}</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button variant="outline" size="sm" onclick={() => void entry.refetch()}>Try again</Button>
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
				<DropdownMenu.Item onclick={download}>Download file</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" disabled={locked} onclick={() => void confirmDelete(captures, stem)}>Delete capture…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<p class="text-xs text-muted-foreground" role="status" aria-label="Save status">
		{form.saving
			? 'Saving…'
			: form.body !== undefined
				? 'Not saved'
				: `Saved to ${path}`}
	</p>

	{#if form.refusal}
		<Alert.Root aria-label="Not applied">
			<Alert.Title>Not applied</Alert.Title>
			<Alert.Description>{form.refusal}</Alert.Description>
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
		{#each [
			{ label: 'Thought not added', text: form.newThought },
			{ label: 'Thought edit not saved', text: form.editing?.text ?? '' },
		].filter((pending) => pending.text !== '') as pending (pending.label)}
			<!-- Typed here and not in the file: kept visible to copy, since the form cannot show it now. -->
			<Field.Field>
				<Field.Label>{pending.label}</Field.Label>
				<Textarea aria-label={pending.label} readonly value={pending.text} rows={rowsFor(pending.text)} />
				<div>
					<Button variant="outline" size="sm" onclick={() => copy(pending.text, 'Text')}>Copy text</Button>
				</div>
			</Field.Field>
		{/each}
		{#if form.unsent}
			<p class="text-sm text-muted-foreground">It stays here until you clear it.</p>
		{/if}
	{:else}
		<div class="flex flex-col gap-8">
			<Field.Field>
				<Field.Label for="capture-text">Capture text</Field.Label>
				<Textarea
					id="capture-text"
					readonly={locked}
					bind:value={() => text, (typed) => form.inputText(typed)}
					onblur={() => void form.flush()}
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

				{#if form.editing !== undefined && thoughts[form.editing.index] === undefined}
					{@const edit = form.editing}
					<Alert.Root aria-label="Kept thought edit">
						<Alert.Title>Your edit to a thought was not applied</Alert.Title>
						<Alert.Description>The capture changed after you started editing, and that thought is gone. Your text is kept here; copy it, then cancel.</Alert.Description>
						{#key edit.id}
							<ThoughtEditForm {form} {edit} {locked} onSaved={() => {}} onCancelled={() => void focusThought(0)} />
						{/key}
					</Alert.Root>
				{/if}

				{#if thoughts.length}
					{@const shown = thoughts}
					<ol bind:this={thoughtList} aria-label="Thoughts" class="list-decimal divide-y border-y pl-6 marker:text-muted-foreground">
						{#each shown as thought, index (index)}
							<li class="py-1 pl-1">
								{#if form.editing?.index === index}
									{@const edit = form.editing}
									<!-- One form per edit: a new edit, even of this same thought, gets a new form. -->
									{#key edit.id}
										<ThoughtEditForm
											{form}
											{edit}
											{locked}
											onSaved={() => void focusThought(index)}
											onCancelled={() => void focusThought(index)}
										/>
									{/key}
								{:else}
									<div class="flex items-start gap-2">
										<p class="min-w-0 flex-1 whitespace-pre-wrap break-words py-1.5 leading-relaxed {thought ? '' : 'text-muted-foreground'}">{thought || 'Empty thought'}</p>
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button {...props} variant="ghost" size="sm" class="text-muted-foreground" aria-label="Thought actions" data-thought-actions>Actions</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end" class="w-48" onCloseAutoFocus={onMenuClosed}>
												<DropdownMenu.Item disabled={locked || form.editing !== undefined} onclick={() => {
													form.startEditing(index, shown);
													// The editor takes focus as it appears; the menu must not take it back.
													afterMenu = () => {};
												}}>Edit</DropdownMenu.Item>
												<DropdownMenu.Item disabled={locked || index === 0} onclick={() => {
													if (form.swapThoughts(index, index - 1, shown)) afterMenu = () => void focusThought(index - 1);
												}}>Move up</DropdownMenu.Item>
												<DropdownMenu.Item disabled={locked || index === shown.length - 1} onclick={() => {
													if (form.swapThoughts(index, index + 1, shown)) afterMenu = () => void focusThought(index + 1);
												}}>Move down</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item onclick={() => copy(thought, 'Thought')}>Copy text</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item variant="destructive" disabled={locked} onclick={() => confirmDeleteThought(thought, index, shown)}>Delete thought…</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</div>
								{/if}
							</li>
						{/each}
					</ol>
				{/if}

				<form
					onsubmit={(event) => {
						event.preventDefault();
						form.addThought();
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
							bind:value={() => form.newThought, form.inputNewThought}
							onkeydown={submitOnModEnter}
							rows={2}
							class="leading-relaxed"
							placeholder="Write a line or paragraph…"
						/>
					</Field.Field>
					<div class="flex items-center justify-between gap-3">
						<p class="text-xs text-muted-foreground">
							{#if form.newThought !== ''}
								Not added yet. It stays here until you add it or clear it.
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
