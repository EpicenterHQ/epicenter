<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Item from '@epicenter/ui/item';
	import * as Modal from '@epicenter/ui/modal';
	import { onDestroy } from 'svelte';
	import { Textarea } from '@epicenter/ui/textarea';
	import { createQuery } from '@tanstack/svelte-query';
	import { type Captures, describeFailure, timelineOf } from '$lib/captures.svelte.js';
	import TechnicalDetails from './TechnicalDetails.svelte';

	let {
		captures,
		onCreated,
	}: {
		captures: Captures;
		/** The new capture is open; the next thing to type is a thought. */
		onCreated: () => void;
	} = $props();

	const listing = createQuery(() => captures.rowsQuery(timelineOf));
	const timeline = $derived(listing.data?.rows ?? []);
	const repairs = $derived(listing.data?.repairs ?? []);
	const unreadable = $derived(listing.data?.unreadable ?? []);
	/** Adding opens the new capture, which unmounts this view before the add answers. */
	let creating = $state(false);

	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

	let dialogOpen = $state(false);
	let createProblem = $state('');
	/** The capture just added is opening: focus goes there, not back to the button. */
	let created = false;
	/** Cleared on destroy: the collection outlives this view, and a held form must not submit to it. */
	let mounted = true;
	onDestroy(() => {
		mounted = false;
	});

	// The text lives in `captures`, so closing the dialog keeps it and leaving
	// the page asks first.
	async function addCapture(event: SubmitEvent) {
		event.preventDefault();
		if (!mounted || creating) return;
		if (captures.newCapture.trim() === '') {
			createProblem = 'Write something first.';
			return;
		}
		creating = true;
		const { error } = await captures.create(captures.newCapture);
		creating = false;
		if (error !== null) {
			createProblem = `The capture was not saved: ${describeFailure(error)} Your text is still here.`;
			return;
		}
		createProblem = '';
		created = true;
		dialogOpen = false;
		onCreated();
	}
</script>

{#snippet newCaptureButton()}
	<Button aria-haspopup="dialog" onclick={() => (dialogOpen = true)}>
		New capture{captures.newCapture === '' ? '' : ' (draft)'}
	</Button>
{/snippet}

<div class="mb-4 flex min-h-9 items-center justify-between gap-4">
	<h1 class="text-lg font-semibold tracking-tight">Timeline</h1>
	<!-- The empty timeline holds this button itself. -->
	{#if timeline.length || !listing.isSuccess}{@render newCaptureButton()}{/if}
</div>

<Modal.Root bind:open={dialogOpen}>
	<Modal.Content
		class="md:max-w-xl"
		onCloseAutoFocus={(event) => {
			if (created) event.preventDefault();
		}}
	>
		<Modal.Header>
			<Modal.Title>New capture</Modal.Title>
			<Modal.Description>It is saved as a Markdown file, exactly as written.</Modal.Description>
		</Modal.Header>
		<form onsubmit={addCapture} class="flex flex-col gap-4 px-4 pb-4 md:p-0">
			<Field.Field>
				<Field.Label for="new-capture">Capture text</Field.Label>
				<!-- Its own lifetime: the collection keeps the text after this view is gone. -->
				<Textarea
					id="new-capture"
					readonly={captures.fenced}
					bind:value={
						() => captures.newCapture,
						(value) => {
							if (!mounted) return;
							createProblem = '';
							captures.inputNewCapture(value);
						}
					}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					rows={6}
					aria-invalid={createProblem !== ''}
					class="max-h-64 min-h-32"
					placeholder="Write or paste something…"
				/>
				<Field.Description>Closing keeps this text until you add it or clear it. Ctrl or ⌘ + Enter adds it.</Field.Description>
				{#if createProblem}<Field.Error>{createProblem}</Field.Error>{/if}
			</Field.Field>
			<Modal.Footer class="flex-row justify-end gap-2 p-0">
				<Button type="button" variant="outline" onclick={() => (dialogOpen = false)}>Close</Button>
				<Button type="submit" disabled={creating || captures.fenced}>{creating ? 'Saving…' : 'Add capture'}</Button>
			</Modal.Footer>
		</form>
	</Modal.Content>
</Modal.Root>

{#if captures.failures.length}
	<!-- A save that failed keeps its edit; this says where, from wherever the person is. -->
	<Alert.Root variant="destructive" aria-label="Not saved" class="mb-4">
		<Alert.Title>Some changes are not saved</Alert.Title>
		<Alert.Description>Each edit is still here. Open the capture to save it again or copy it.</Alert.Description>
		<ul class="mt-2 flex flex-col gap-2 text-foreground">
			{#each captures.failures as failure (failure.path)}
				<li class="flex flex-wrap items-start gap-2">
					<p class="min-w-0 flex-1 break-words"><code class="break-all">{failure.path}</code>: {failure.reason}</p>
					<Button size="sm" variant="outline" aria-label="Open {failure.path}" onclick={() => captures.open(failure.stem, 'capture')}>Open</Button>
				</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

{#if listing.isError}
	<Alert.Root variant="destructive" class="mb-4">
		<Alert.Title>Your captures could not be read</Alert.Title>
		<Alert.Description>What is listed here may be out of date. Text you have typed in this window is still here.</Alert.Description>
		<div class="mt-2 text-foreground"><Button variant="outline" size="sm" onclick={() => void listing.refetch()}>Check again</Button></div>
		<TechnicalDetails detail={listing.error.message} />
	</Alert.Root>
{/if}

{#if timeline.length}
	<Item.Group aria-label="Timeline captures" class="gap-1">
		{#each timeline as row (row.path)}
			<Item.Button size="sm" class="w-full text-left hover:bg-muted" onclick={() => captures.open(row.stem, 'capture')}>
				<Item.Content>
					<Item.Title class={['line-clamp-2 whitespace-pre-line break-words', !row.preview && 'text-muted-foreground']}>{row.preview || 'Empty capture'}</Item.Title>
					<Item.Description class="text-xs">
						{#if row.capturedAt}
							<time datetime={row.capturedAt.toISOString()}>{when.format(row.capturedAt)}</time>
						{:else}
							No capture date
						{/if}
						{#if row.thoughtCount > 0} · {row.thoughtCount} {row.thoughtCount === 1 ? 'thought' : 'thoughts'}{/if}
					</Item.Description>
				</Item.Content>
			</Item.Button>
		{/each}
	</Item.Group>
{:else if listing.isSuccess}
	<Empty.Root>
		<Empty.Header>
			<Empty.Title>No captures yet</Empty.Title>
			<Empty.Description>Write or paste something to keep. Each capture is one Markdown file, and you can add thoughts to it later.</Empty.Description>
		</Empty.Header>
		<Empty.Content>{@render newCaptureButton()}</Empty.Content>
	</Empty.Root>
{/if}

{#if repairs.length}
	<!-- Not offered as captures: each opens as text, where it can be repaired. -->
	<Alert.Root variant="destructive" aria-label="Files to repair" class="mt-6">
		<Alert.Title>{repairs.length} {repairs.length === 1 ? 'file does' : 'files do'} not read as a capture</Alert.Title>
		<Alert.Description>They are not listed above, and nothing in them was changed. Edit one as text to repair it.</Alert.Description>
		<ul class="mt-2 flex flex-col gap-2 text-foreground">
			{#each repairs as row (row.path)}
				<li class="flex flex-wrap items-start gap-2">
					<p class="min-w-0 flex-1 break-words"><code class="break-all">{row.path}</code>: {row.problem}</p>
					<Button size="sm" variant="outline" aria-label="Edit {row.path} as text" onclick={() => captures.open(row.stem, 'text')}>Edit as text</Button>
				</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

{#if unreadable.length}
	<Alert.Root variant="destructive" aria-label="Unreadable files" class="mt-6">
		<Alert.Title>{unreadable.length} {unreadable.length === 1 ? 'file' : 'files'} could not be read</Alert.Title>
		<Alert.Description>They are not text. They are kept as they are, untouched.</Alert.Description>
		<ul class="mt-1 list-disc pl-5 text-foreground">
			{#each unreadable as file (file.path)}
				<li class="break-words"><code>{file.path}</code>: {file.message}</li>
			{/each}
		</ul>
	</Alert.Root>
{/if}

<footer class="mt-10 border-t pt-4 text-xs text-muted-foreground">
	<p>Captures are kept in this browser, each as a Markdown file in <code>captures</code>. They are not synced to other devices.</p>
</footer>
