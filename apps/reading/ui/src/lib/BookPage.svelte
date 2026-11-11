<!--
	One book: its author, its days, my rating, and my notes. A field is saved
	through `set` as soon as it changes; the notes are saved through `edit`
	when they lose focus or the page is hidden, quoting the notes they were
	typed over, so notes an agent changed meanwhile are not overwritten without
	asking. Until then the notes typed here show over the book as last read.
--><script lang="ts">
	import { type ActionError, changedElsewhere } from '@epicenter/app/client';
	import { goto } from '$app/navigation';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import Stars from '$lib/Stars.svelte';
	import { reads, writes } from '$lib/app.js';

	let { path: given }: { path: string } = $props();
	// The route keys this page by its path, so it is fixed.
	const path = untrack(() => given);

	const book = createQuery(() => reads.get({ path }));
	const setBook = createMutation(() => writes.set);
	const editBook = createMutation(() => writes.edit);
	const startBook = createMutation(() => writes.start);
	const finishBook = createMutation(() => writes.finish);
	const deleteBook = createMutation(() => writes.delete);

	/** The notes as typed, while they are not saved. */
	let draft = $state<string>();
	/** The body `draft` was typed over, which the edit quotes. */
	let base = '';

	const shown = (body: string) => body.replace(/\r?\n$/, '');

	const toastError = (failed: string) => (error: ActionError) =>
		toast.error(failed, { description: error.message });

	/** Save the notes typed over `base`, quoting it, unless a save is already on its way. */
	function saveNotes() {
		if (draft === undefined || editBook.isPending) return;
		const sent = draft;
		const typed = sent === '' || sent.endsWith('\n') ? sent : `${sent}\n`;
		if (typed === base) {
			draft = undefined;
			return;
		}
		editBook.mutate(
			{ path, old: base, new: typed },
			{
				onSuccess: () => {
					if (draft === sent) draft = undefined;
					else base = typed;
				},
				onError: (error) => {
					if (!changedElsewhere(error)) return toastError('Could not save the notes')(error);
					toast.error('The notes changed elsewhere', {
						description: 'Yours were not saved.',
						action: {
							label: 'Keep mine',
							onClick: () => {
								// The failed edit refreshed the book, so this is the body to replace.
								base = book.data?.body ?? base;
								saveNotes();
							},
						},
					});
				},
			},
		);
	}

	function confirmDelete() {
		confirmationDialog.open({
			title: `Delete ${book.data?.title}?`,
			description: 'This deletes the book and my notes on it.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				draft = undefined;
				await deleteBook.mutateAsync({ path });
				toast('Book deleted');
				await goto('#/');
			},
		});
	}
</script>

<svelte:window onpagehide={saveNotes} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') saveNotes();
	}}
/>

<div class="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
	<header
		class="sticky top-0 z-10 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur"
	>
		<div class="mx-auto flex h-14 max-w-xl items-center px-2">
			<Button variant="ghost" href="#/" class="h-11 gap-0.5 pr-3 text-base">
				<ChevronLeftIcon class="size-5" />
				Reading
			</Button>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
		{#if book.isPending}
			<div class="flex justify-center py-16" role="status" aria-label="Loading the book">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else if !book.data && book.error?.name === 'Unreachable'}
			<Empty.Root class="py-16">
				<Empty.Title>Epicenter did not answer</Empty.Title>
				<Empty.Description>{book.error.message}</Empty.Description>
				<Button variant="outline" onclick={() => book.refetch()}>Try again</Button>
			</Empty.Root>
		{:else if !book.data}
			<Empty.Root class="py-16">
				<Empty.Title>No book here</Empty.Title>
				<Empty.Description>{book.error?.message || 'It was deleted, here or elsewhere.'}</Empty.Description>
				<Button variant="outline" href="#/">Back to reading</Button>
			</Empty.Root>
		{:else}
			{@const file = book.data}
			<h1 class="text-2xl font-semibold tracking-tight break-anywhere">{file.title}</h1>
			<Input
				class="mt-2 h-11 text-base"
				placeholder="Author"
				aria-label="Author"
				value={file.author ?? ''}
				onchange={(event) => {
					const author = event.currentTarget.value.trim();
					if (author !== (file.author ?? ''))
						setBook.mutate({ path, author: author || null }, { onError: toastError('Could not save the book') });
				}}
			/>

			<div class="mt-4 flex flex-wrap gap-2">
				{#if !file.started || file.finished}
					<Button
						variant={file.started ? 'outline' : 'default'}
						class="h-11"
						onclick={() => startBook.mutate({ title: file.title }, { onError: toastError('Could not start the book') })}
					>
						{file.finished ? 'Read it again' : 'Start reading'}
					</Button>
				{/if}
				{#if !file.finished}
					<Button
						variant={file.started ? 'default' : 'outline'}
						class="h-11"
						onclick={() => finishBook.mutate({ title: file.title }, { onError: toastError('Could not finish the book') })}
					>
						Finished
					</Button>
				{/if}
			</div>

			<div class="mt-6 grid grid-cols-2 gap-3">
				{#each [{ key: 'started', label: 'Started' }, { key: 'finished', label: 'Finished' }] as const as day (day.key)}
					<div>
						<Label for={day.key} class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
							{day.label}
						</Label>
						<Input
							id={day.key}
							type="date"
							class="mt-2 h-11"
							value={file[day.key] ?? ''}
							onchange={(event) => {
								const value = event.currentTarget.value;
								setBook.mutate(
									{ path, [day.key]: value === '' ? null : value },
									{ onError: toastError('Could not save the book') },
								);
							}}
						/>
					</div>
				{/each}
			</div>

			<section class="mt-6">
				<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Rating</p>
				<div class="mt-1 -ml-2.5">
					<Stars
						rating={file.rating}
						size="size-6"
						onRate={(rating) => setBook.mutate({ path, rating }, { onError: toastError('Could not save the book') })}
					/>
				</div>
			</section>

			<section class="mt-6">
				<Label for="notes" class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
					Notes
				</Label>
				<Textarea
					id="notes"
					class="mt-2 min-h-48 resize-none text-base"
					placeholder="Thoughts, quotes, where I left off, in Markdown"
					bind:value={
						() => draft ?? shown(file.body),
						(value) => {
							if (draft === undefined) base = file.body;
							draft = value;
						}
					}
					onblur={saveNotes}
				/>
			</section>

			{#if file.problems}
				<div class="mt-8 text-xs text-muted-foreground" role="note">
					<p>Some of this book's file could not be read:</p>
					<ul class="mt-1 list-disc pl-4 font-mono break-anywhere">
						{#each file.problems as line (line)}
							<li>{line}</li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="mt-10 flex items-center gap-2 border-t pt-4">
				<span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</span>
				<Button variant="ghost-destructive" class="ml-auto" onclick={confirmDelete}>Delete</Button>
			</div>
		{/if}
	</main>
</div>
