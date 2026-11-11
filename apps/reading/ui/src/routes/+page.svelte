<!--
	The shelves: a quick add at the top, then the books I am reading, the ones
	I mean to read, and the ones I have read. A book I mean to read starts with
	one tap, and one I am reading finishes with one.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import Stars from '$lib/Stars.svelte';
	import type { ActionError } from '@epicenter/app/client';
	import { type Book, reads, writes } from '$lib/app.js';
	import { dayLabel, hrefOf, shelves } from '$lib/shelves.js';

	const books = createQuery(() => reads.list());
	const addBook = createMutation(() => writes.add);
	const startBook = createMutation(() => writes.start);
	const finishBook = createMutation(() => writes.finish);

	let title = $state('');

	function add() {
		const typed = title.trim();
		if (typed === '') return;
		title = '';
		addBook.mutate(
			{ title: typed },
			{
				onError: (error) => {
					if (title === '') title = typed;
					toast.error('Could not add the book', { description: error.message });
				},
			},
		);
	}

	/** Each row's move settles its own promise, so two quick taps each get their toast. */
	function move(book: Book, to: 'start' | 'finish') {
		const write = to === 'start' ? startBook : finishBook;
		write.mutateAsync({ title: book.title }).then(
			() => toast(to === 'start' ? `Started ${book.title}` : `Finished ${book.title}`),
			(error: ActionError) => toast.error(`Could not change ${book.title}`, { description: error.message }),
		);
	}
</script>

<div class="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
	<header
		class="sticky top-0 z-10 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur"
	>
		<div class="mx-auto max-w-xl px-4 pt-4 pb-3">
			<h1 class="mb-3 text-2xl font-semibold tracking-tight">Reading</h1>
			<form
				class="flex gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					add();
				}}
			>
				<Input
					bind:value={title}
					class="h-11 text-base"
					placeholder="Add a book to read"
					aria-label="New book's title"
					enterkeyhint="done"
					autocomplete="off"
				/>
				<IconButton
					label="Add book"
					size="lg"
					type="submit"
					class="size-11"
					disabled={title.trim() === ''}
				>
					<PlusIcon />
				</IconButton>
			</form>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+6rem)]">
		{#if books.error}
			<Alert.Root variant="destructive" class="mt-3">
				<Alert.Title>Epicenter did not answer</Alert.Title>
				<Alert.Description>
					<p>{books.error.message}</p>
					<Button variant="outline" size="sm" class="mt-2" onclick={() => books.refetch()}>
						Try again
					</Button>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if books.isPending}
			<div class="flex justify-center py-16" role="status" aria-label="Loading books">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else}
			{#each shelves(books.data ?? []) as group (group.key)}
				<section class="mt-4" aria-labelledby="shelf-{group.key}">
					<h2
						id="shelf-{group.key}"
						class="text-xs font-medium tracking-wide text-muted-foreground uppercase"
					>
						{group.label}
					</h2>
					<ul>
						{#each group.books as book (book.path)}
							<li class="flex items-center gap-3 border-b border-border/60 last:border-b-0">
								<a
									href={hrefOf(book.path)}
									class="flex min-h-14 min-w-0 flex-1 flex-col justify-center py-2 outline-none focus-visible:underline"
								>
									<span class="break-anywhere">
										{book.title}
										{#if book.problems}
											<TriangleAlertIcon
												class="inline size-3.5 align-[-0.125em] text-muted-foreground"
												aria-label="Some of its file could not be read"
											/>
										{/if}
									</span>
									<span class="flex items-center gap-2 text-xs text-muted-foreground">
										{#if book.author}<span class="truncate">{book.author}</span>{/if}
										{#if group.key === 'reading' && book.started}
											<span>since {dayLabel(book.started)}</span>
										{:else if group.key === 'read' && book.finished}
											<span>{dayLabel(book.finished)}</span>
											<Stars rating={book.rating} size="size-3" />
										{/if}
									</span>
								</a>
								{#if group.key === 'next'}
									<Button variant="outline" size="sm" class="h-10" onclick={() => move(book, 'start')}>
										Start
									</Button>
								{:else if group.key === 'reading'}
									<Button variant="outline" size="sm" class="h-10" onclick={() => move(book, 'finish')}>
										Finish
									</Button>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{:else}
				{#if !books.error}
					<Empty.Root class="py-16">
						<Empty.Title>No books yet</Empty.Title>
						<Empty.Description>Add one above, or ask your agent to.</Empty.Description>
					</Empty.Root>
				{/if}
			{/each}
		{/if}
	</main>
</div>
