<!-- A completed capture. One body draft holds text and thought commands until saves answer. -->
<script lang="ts">
	import { captureBody } from '@epicenter/capture';
	import { describeIssues } from '@epicenter/folder';
	import { draft } from '@epicenter/svelte/folder';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';

	import { onDestroy, tick, untrack } from 'svelte';
	import { createCaptureActions, locateThought } from '$lib/capture-actions.svelte.js';
	import { type Captures, capturePath, instantOf } from '$lib/captures.svelte.js';
	import { getFolder } from '$lib/folder.js';
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
	const folder = getFolder();
	let active = true;
	onDestroy(() => {
		active = false;
	});
	const row = $derived(folder.tables.captures.row(stem));
	const stored = $derived(row?.issues === null && row.fields.draft !== true ? row : undefined);
	const body = draft(
		() => stored?.body ?? '',
		(next) => folder.tables.captures.update(stem, { body: next }),
	);
	const actions = createCaptureActions(body);
	/** Opened right after Add: focus goes to Add a thought. */
	const focusNewThought = untrack(() => captures.opened?.focus === 'new-thought');
	const reading = $derived(stored && captureBody.decode(body.value));
	const text = $derived(reading?.data?.text ?? '');
	const thoughts = $derived(reading?.data?.thoughts ?? []);
	const capturedAt = $derived(instantOf(stored?.fields.capturedAt));
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
	let menuThoughts: readonly string[] = [];
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

	async function openText() {
		if ((await body.land()).error !== null) return;
		if (!active) return;
		captures.open(stem, 'text');
	}

	/** Export the file after explicitly saving the text shown in this editor. */
	async function download() {
		if ((await body.land()).error !== null) return;
		if (!active) return;
		const data = folder.file(path)?.data;
		if (typeof data !== 'string') {
			toast.error('Could not download this capture', { description: 'Its text is not available.' });
			return;
		}
		downloadText(`${stem}.md`, data);
	}

	async function editThought(index: number, list: readonly string[]) {
		if ((await body.land()).error !== null) return;
		if (!active) return;
		const saved = folder.tables.captures.row(stem);
		const data = folder.file(path)?.data;
		const range = saved?.issues === null && typeof data === 'string'
			? locateThought(data, saved.body, index, list) : undefined;
		if (range === undefined) {
			actions.refuseChanged();
			return;
		}
		captures.open(stem, 'text', range);
	}

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

<UnsavedEdit draft={body} />

{#if reading === undefined}
	<div class="flex flex-col gap-4">
		<Button variant="outline" size="sm" class="self-start" onclick={() => captures.leave()}>Back to timeline</Button>
		{#if row?.fields && row.issues === null && row.fields.draft === true}
			<Alert.Root>
				<Alert.Title>This file is a draft</Alert.Title>
				<Alert.Description>Edit its Markdown as text to continue writing or finish it.</Alert.Description>
				<div class="mt-2"><Button size="sm" onclick={() => void openText()}>Edit as text</Button></div>
			</Alert.Root>
		{:else if row?.issues && !row.issues.some((issue) => issue.kind === 'unreadable' || issue.kind === 'not-text')}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This file does not read as a capture</Empty.Title>
					<Empty.Description>{describeIssues(row.issues)}</Empty.Description>
				</Empty.Header>
				<Empty.Content><Button size="sm" onclick={() => void openText()}>Edit as text</Button></Empty.Content>
			</Empty.Root>
		{:else if row === undefined}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This capture is no longer here</Empty.Title>
					<Empty.Description>It was deleted, here or in another tab.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else if row.issues?.some((issue) => issue.kind === 'not-text')}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This file is not text</Empty.Title>
					<Empty.Description>It cannot be edited as a capture. Nothing in it was changed.</Empty.Description>
				</Empty.Header>
			</Empty.Root>
		{:else}
			<Empty.Root role="alert">
				<Empty.Header>
					<Empty.Title>This capture could not be read</Empty.Title>
					<Empty.Description>{row.issues && describeIssues(row.issues)}</Empty.Description>
				</Empty.Header>
				<Empty.Content>
					<Button variant="outline" size="sm" onclick={() => void folder.refresh()}>Try again</Button>
				</Empty.Content>
			</Empty.Root>
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
		<Button variant="outline" size="sm" onclick={() => void openText()}>Edit as text</Button>
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
				<DropdownMenu.Item variant="destructive" onclick={() => void confirmDelete(captures, stem)}>Delete capture…</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

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
				<Button size="sm" onclick={() => void openText()}>Edit as text</Button>
			</div>
		</Alert.Root>

	{:else}
		<div class="flex flex-col gap-8">
			<Field.Field>
				<Field.Label for="capture-text">Capture text</Field.Label>
				<Textarea
					id="capture-text"
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
									<DropdownMenu.Root onOpenChange={(open) => { if (open) menuThoughts = [...thoughts]; }}>
										<DropdownMenu.Trigger>
											{#snippet child({ props })}
												<Button {...props} variant="ghost" size="sm" class="text-muted-foreground" aria-label="Thought actions" data-thought-actions>Actions</Button>
											{/snippet}
										</DropdownMenu.Trigger>
										<DropdownMenu.Content align="end" class="w-48" onCloseAutoFocus={onMenuClosed}>
											<DropdownMenu.Item onclick={() => {
											// Save the body before locating its lines in the file.
												const list = menuThoughts;
												afterMenu = () => { void editThought(index, list); };
											}}>Edit as text</DropdownMenu.Item>
										<DropdownMenu.Item disabled={index === 0} onclick={() => {
												if (actions.swapThoughts(index, index - 1, menuThoughts)) afterMenu = () => void focusThought(index - 1);
											}}>Move up</DropdownMenu.Item>
										<DropdownMenu.Item disabled={index === shown.length - 1} onclick={() => {
												if (actions.swapThoughts(index, index + 1, menuThoughts)) afterMenu = () => void focusThought(index + 1);
											}}>Move down</DropdownMenu.Item>
											<DropdownMenu.Separator />
											<DropdownMenu.Item onclick={() => copy(thought, 'Thought')}>Copy text</DropdownMenu.Item>
											<DropdownMenu.Separator />
										<DropdownMenu.Item variant="destructive" onclick={() => confirmDeleteThought(thought, index, menuThoughts)}>Delete thought…</DropdownMenu.Item>
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
						const submitted = newThought;
						if (actions.addThought(submitted)) {
							newThought = '';
						}
						newThoughtField?.focus();
					}}
					class="flex flex-col gap-2"
				>
					<Field.Field>
						<Field.Label for="new-thought">Add a thought</Field.Label>
						<Textarea
							id="new-thought"
							bind:ref={newThoughtField}
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
						<Button type="submit" size="sm">Add thought</Button>
					</div>
				</form>

				{#if reading.data?.hasOtherContent}
					<p class="text-muted-foreground">This file has more Markdown after its thoughts. Structured edits preserve that body content; Edit as text shows it.</p>
				{/if}
			</section>
		</div>
	{/if}
</div>
{/if}

{#if newThought !== '' && !reading?.data}
	<!-- Typed here and not in the file: kept visible to copy, since Add a thought cannot show it now. -->
	<Field.Field>
		<Field.Label>Thought not added</Field.Label>
		<Textarea aria-label="Thought not added" readonly value={newThought} rows={rowsFor(newThought)} />
		<div>
			<Button variant="outline" size="sm" onclick={() => copy(newThought, 'Text')}>Copy text</Button>
		</div>
	</Field.Field>
{/if}
