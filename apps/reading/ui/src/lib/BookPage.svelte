<!--
	One book: its author, its days, my rating, and my notes. A field is saved
	through `set` as soon as it changes; the notes are saved through `edit`
	when they lose focus or the page is hidden, quoting them as loaded, so
	notes an agent changed meanwhile are not overwritten without asking.
-->
<script lang="ts">
	import { ActionError, changedElsewhere } from '@epicenter/app/client';
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
	import { untrack } from 'svelte';
	import Stars from '$lib/Stars.svelte';
	import { app, type BookFile, shelf } from '$lib/books.svelte.js';

	let { path: given }: { path: string } = $props();
	// The route keys this page by its path, so it is fixed.
	const path = untrack(() => given);

	let book = $state<BookFile>();
	let phase = $state<'loading' | 'ready' | 'gone' | 'failed'>('loading');
	let problem = $state('');
	let notes = $state('');
	/** The notes as the server last returned them, which an edit quotes. */
	let base = '';

	async function load() {
		phase = 'loading';
		try {
			book = await app.get({ path });
			base = book.body;
			notes = base.replace(/\r?\n$/, '');
			phase = 'ready';
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
			phase = error instanceof ActionError && error.kind === 'transport' ? 'failed' : 'gone';
		}
	}
	void load();

	/** Show what a write answered, keeping the notes as typed. */
	async function wrote(call: Promise<BookFile>, failed: string) {
		try {
			book = await shelf.write(call);
		} catch (error) {
			toast.error(failed, { description: String(error) });
			void load();
		}
	}

	const set = (fields: Omit<Parameters<typeof app.set>[0], 'path'>) =>
		wrote(app.set({ path, ...fields }), 'Could not save the book');

	async function saveNotes() {
		const typed = notes === '' || notes.endsWith('\n') ? notes : `${notes}\n`;
		if (phase !== 'ready' || typed === base) return;
		try {
			const file = await shelf.write(app.edit({ path, old: base, new: typed }));
			base = file.body;
		} catch (error) {
			if (!changedElsewhere(error)) {
				toast.error('Could not save the notes', { description: String(error) });
				return;
			}
			toast.error('The notes changed elsewhere', {
				description: 'Yours were not saved.',
				action: {
					label: 'Keep mine',
					onClick: async () => {
						base = (await app.get({ path })).body;
						void saveNotes();
					},
				},
			});
		}
	}

	function confirmDelete() {
		confirmationDialog.open({
			title: `Delete ${book?.title}?`,
			description: 'This deletes the book and my notes on it.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				phase = 'gone';
				await shelf.remove(path);
				toast('Book deleted');
				await goto('#/');
			},
		});
	}
</script>

<svelte:window onpagehide={() => void saveNotes()} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void saveNotes();
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
		{#if phase === 'loading'}
			<div class="flex justify-center py-16" role="status" aria-label="Loading the book">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else if phase === 'gone' || !book}
			<Empty.Root class="py-16">
				<Empty.Title>No book here</Empty.Title>
				<Empty.Description>{problem || 'It was deleted, here or elsewhere.'}</Empty.Description>
				<Button variant="outline" href="#/">Back to reading</Button>
			</Empty.Root>
		{:else if phase === 'failed'}
			<Empty.Root class="py-16">
				<Empty.Title>Epicenter did not answer</Empty.Title>
				<Empty.Description>{problem}</Empty.Description>
				<Button variant="outline" onclick={load}>Try again</Button>
			</Empty.Root>
		{:else}
			<h1 class="text-2xl font-semibold tracking-tight break-anywhere">{book.title}</h1>
			<Input
				class="mt-2 h-11 text-base"
				placeholder="Author"
				aria-label="Author"
				value={book.author ?? ''}
				onchange={(event) => {
					const author = event.currentTarget.value.trim();
					if (author !== (book?.author ?? '')) void set({ author: author || null });
				}}
			/>

			<div class="mt-4 flex flex-wrap gap-2">
				{#if !book.started || book.finished}
					<Button
						variant={book.started ? 'outline' : 'default'}
						class="h-11"
						onclick={() => wrote(app.start({ title: book?.title ?? '' }), 'Could not start the book')}
					>
						{book.finished ? 'Read it again' : 'Start reading'}
					</Button>
				{/if}
				{#if !book.finished}
					<Button
						variant={book.started ? 'default' : 'outline'}
						class="h-11"
						onclick={() => wrote(app.finish({ title: book?.title ?? '' }), 'Could not finish the book')}
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
							value={book[day.key] ?? ''}
							onchange={(event) => {
								const value = event.currentTarget.value;
								void set({ [day.key]: value === '' ? null : value });
							}}
						/>
					</div>
				{/each}
			</div>

			<section class="mt-6">
				<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Rating</p>
				<div class="mt-1 -ml-2.5">
					<Stars rating={book.rating} size="size-6" onRate={(rating) => void set({ rating })} />
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
					bind:value={notes}
					onblur={() => void saveNotes()}
				/>
			</section>

			{#if book.problems}
				<div class="mt-8 text-xs text-muted-foreground" role="note">
					<p>Some of this book's file could not be read:</p>
					<ul class="mt-1 list-disc pl-4 font-mono break-anywhere">
						{#each book.problems as line (line)}
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
