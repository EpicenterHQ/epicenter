<!--
	One open capture as its text and thoughts. Every change saves at once
	through the capture's row session; "Edit as text" opens the file's exact
	Markdown instead. The parent keys this view by the open capture, so
	another capture mounts a new view.

	When the body stops reading as text and thoughts (a version reloaded from
	elsewhere with two Thoughts headings, say), the controls go away rather
	than show values the file does not have, and Edit as text is the way to
	repair it.
-->
<script lang="ts">
	import { captureDefinition } from '@epicenter/capture';
	import { formatRow } from '@epicenter/folder';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Field from '@epicenter/ui/field';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import { tick, untrack } from 'svelte';
	import { type Captures, instantOf, type Opened } from '$lib/captures.svelte.js';
	import { copyText, downloadText } from '$lib/download.js';
	import { backToTimeline, confirmDelete, openItem } from '$lib/item-actions.js';
	import SaveBar from '@epicenter/svelte/save-bar';
	import ThoughtEditForm from './ThoughtEditForm.svelte';

	let {
		captures,
		item,
		focusNewThought = false,
	}: {
		captures: Captures;
		/** The open capture. The parent keys this view by it. */
		item: Extract<Opened, { kind: 'capture' }>;
		/** The capture was just added: the next thing to type is a thought. */
		focusNewThought?: boolean;
	} = $props();

	// The view is keyed by the item, so it never changes for this view.
	const { session, form, stem } = untrack(() => item);
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	const capturedAt = $derived(instantOf(session.draft.fields.capturedAt));

	let newThoughtField = $state<HTMLTextAreaElement | null>(null);
	let thoughtList = $state<HTMLOListElement>();

	// The new capture opens before its creation is reported, so this follows the prop.
	$effect(() => {
		if (focusNewThought) untrack(() => newThoughtField)?.focus();
	});

	// Engines without content-sized fields fall back to this many rows.
	const rowsFor = (text: string) => Math.min(12, Math.max(3, text.split('\n').length + 1));

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

	async function copy(text: string, what: string) {
		if (await copyText(text)) toast.success(`${what} copied`);
		else toast.error('Could not copy. Select the text and copy it.');
	}

	function download() {
		const { data: text, error } = formatRow(captureDefinition.tables.captures, session.draft);
		if (error !== null) toast.error('Could not download this capture', { description: error.message });
		else downloadText(`${stem}.md`, text);
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

<div class="flex flex-col gap-4">
	<div class="flex flex-wrap items-center gap-x-3 gap-y-2">
		<Button variant="outline" size="sm" onclick={() => void backToTimeline(captures)}>Back to timeline</Button>
		<h1 class="mr-auto text-lg font-semibold tracking-tight">
			{#if capturedAt}
				<time datetime={capturedAt.toISOString()}>{when.format(capturedAt)}</time>
			{:else}
				Capture with no date
			{/if}
		</h1>
		<Button variant="outline" size="sm" onclick={() => void openItem(captures, stem, 'text')}>Edit as text</Button>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="sm" aria-label="More capture actions">More</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-48">
				<DropdownMenu.Item onclick={() => copy(form.text, 'Capture text')}>Copy capture text</DropdownMenu.Item>
				<DropdownMenu.Item onclick={download}>Download file</DropdownMenu.Item>
				<DropdownMenu.Separator />
				<DropdownMenu.Item variant="destructive" disabled={captures.fenced} onclick={() => confirmDelete(captures, form.text.trim().slice(0, 60))}>Delete capture…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<SaveBar
		save={session.state}
		review={session.review}
		class="rounded-md border"
		onRetry={() => session.retry()}
		onResolve={(choices) => captures.resolve(session, choices)}
	/>

	{#if form.refusal}
		<Alert.Root aria-label="Not applied">
			<Alert.Title>Not applied</Alert.Title>
			<Alert.Description>{form.refusal}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if form.reading.error}
		<Alert.Root variant="destructive" aria-label="Needs repair">
			<Alert.Title>This capture cannot be edited as text and thoughts</Alert.Title>
			<Alert.Description>
				<p>{form.reading.error.message}</p>
				<p>Nothing was changed. Edit its Markdown as text to repair it.</p>
			</Alert.Description>
			<div class="mt-2 text-foreground">
				<Button size="sm" onclick={() => void openItem(captures, stem, 'text')}>Edit as text</Button>
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
			<p class="text-sm text-muted-foreground">Leaving this capture, or editing it as text, asks before discarding this text.</p>
		{/if}
	{:else}
		<div class="flex flex-col gap-8">
			<Field.Field>
				<Field.Label for="capture-text">Capture text</Field.Label>
				<Textarea
					id="capture-text"
					readonly={session.locked}
					bind:value={() => form.text, form.inputText}
					rows={rowsFor(form.text)}
					class="max-h-96 resize-y leading-relaxed"
					placeholder="Write here…"
				/>
				<p class="text-sm text-muted-foreground">Changes that cannot be applied return to the current text. Edit as text to write unfinished Markdown.</p>
			</Field.Field>

			<section class="flex flex-col gap-3" aria-label="Capture thoughts">
				<h2 class="font-medium">
					Thoughts
					{#if form.thoughts.length}<span class="font-normal text-muted-foreground">{form.thoughts.length}</span>{/if}
				</h2>

				{#if form.editing !== undefined && form.thoughts[form.editing.index] === undefined}
					{@const edit = form.editing}
					<Alert.Root aria-label="Kept thought edit">
						<Alert.Title>Your edit to a thought was not applied</Alert.Title>
						<Alert.Description>The capture changed after you started editing, and that thought is gone. Your text is kept here; copy it, then cancel.</Alert.Description>
						{#key edit.id}
							<ThoughtEditForm {form} {edit} onSaved={() => {}} onCancelled={() => void focusThought(0)} />
						{/key}
					</Alert.Root>
				{/if}

				{#if form.thoughts.length}
					{@const shown = form.thoughts}
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
												<DropdownMenu.Item disabled={session.locked || form.editing !== undefined} onclick={() => {
													form.startEditing(index, shown);
													// The editor takes focus as it appears; the menu must not take it back.
													afterMenu = () => {};
												}}>Edit</DropdownMenu.Item>
												<DropdownMenu.Item disabled={session.locked || index === 0} onclick={() => {
													if (form.swapThoughts(index, index - 1, shown)) afterMenu = () => void focusThought(index - 1);
												}}>Move up</DropdownMenu.Item>
												<DropdownMenu.Item disabled={session.locked || index === shown.length - 1} onclick={() => {
													if (form.swapThoughts(index, index + 1, shown)) afterMenu = () => void focusThought(index + 1);
												}}>Move down</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item onclick={() => copy(thought, 'Thought')}>Copy text</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item variant="destructive" disabled={session.locked} onclick={() => confirmDeleteThought(thought, index, shown)}>Delete thought…</DropdownMenu.Item>
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
							readonly={session.locked}
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
							{:else if form.thoughts.length}
								Ctrl or ⌘ + Enter adds it after the last thought.
							{:else}
								Thoughts you add are saved in this capture, under its Thoughts heading.
							{/if}
						</p>
						<Button type="submit" size="sm" disabled={session.locked}>Add thought</Button>
					</div>
				</form>

				{#if form.reading.data?.hasOtherContent}
					<p class="text-muted-foreground">This file has more Markdown after its thoughts. It is kept as it is; Edit as text shows it.</p>
				{/if}
			</section>
		</div>
	{/if}
</div>
