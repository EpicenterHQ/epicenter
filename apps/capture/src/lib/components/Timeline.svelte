<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { onDestroy } from 'svelte';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { type Captures, describeFailure, timelineOf } from '$lib/captures.svelte.js';
	import { resultMutationOptions } from 'wellcrafted/query';
	import TechnicalDetails from './TechnicalDetails.svelte';

	let { captures }: { captures: Captures } = $props();

	const listing = createQuery(() => captures.rowsQuery(timelineOf));
	const timeline = $derived(listing.data?.rows ?? []);
	const drafts = $derived(listing.data?.drafts ?? []);
	const repairs = $derived(listing.data?.repairs ?? []);
	const unreadable = $derived(listing.data?.unreadable ?? []);
	const create = createMutation(() => resultMutationOptions({ mutationKey: ['captures', 'create'], mutationFn: () => captures.create() }));
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	let mounted = true;
	onDestroy(() => { mounted = false; });
</script>

{#snippet newCaptureButton()}
	<Button disabled={create.isPending || captures.fenced} onclick={() => {
		if (mounted && !create.isPending) create.mutate();
	}}>{create.isPending ? 'Creating…' : 'New capture'}</Button>
{/snippet}

<div class="mb-4 flex min-h-9 items-center justify-between gap-4">
	<h1 class="text-lg font-semibold tracking-tight">Timeline</h1>
	{#if timeline.length || drafts.length || !listing.isSuccess}{@render newCaptureButton()}{/if}
</div>

{#if create.error}
	<Alert.Root variant="destructive" class="mb-4" role="alert">
		<Alert.Title>Could not create a draft</Alert.Title>
		<Alert.Description>{describeFailure(create.error)} Try New capture again when storage is available.</Alert.Description>
	</Alert.Root>
{/if}

{#if drafts.length}
	<section class="mb-6" aria-label="Draft captures">
		<h2 class="mb-2 font-medium">Drafts</h2>
		<Item.Group class="gap-1">
			{#each drafts as row (row.path)}
				<Item.Button size="sm" class="w-full text-left hover:bg-muted" onclick={() => captures.open(row.stem, 'capture')}>
					<Item.Content>
						<Item.Title class="line-clamp-2 whitespace-pre-line break-words">{row.preview || 'Empty draft'}</Item.Title>
						<Item.Description>Continue writing</Item.Description>
					</Item.Content>
				</Item.Button>
			{/each}
		</Item.Group>
	</section>
{/if}

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
{:else if listing.isSuccess && drafts.length === 0}
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
	<p>Captures are kept on this device, each as a Markdown file in <code>captures</code>. They are not synced to other devices.</p>
</footer>
