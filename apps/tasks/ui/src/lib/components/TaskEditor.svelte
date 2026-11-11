<!--
	One task to edit: whether it is done, its title, its due day, and its
	notes. Done and the due day are saved through `set` as soon as they change
	and show at once; the title and notes are saved shortly after typing stops,
	when they lose focus, and when the page is hidden or left. The notes go
	through `edit`, quoting the notes they were typed over, so notes an agent
	changed meanwhile are not overwritten without asking. Delete asks first.
	When the file has something that does not fit a task, such as a due day
	that is not a day, a note at the bottom quotes it.
-->
<script lang="ts">
	import { type ActionError, changedElsewhere } from '@epicenter/app/client';
	import { goto } from '$app/navigation';
	import { Button } from '@epicenter/ui/button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import XIcon from '@lucide/svelte/icons/x';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { onDestroy, untrack } from 'svelte';
	import { type TaskChanges, reads, sendingSets, writes } from '$lib/app.js';
	import { addDays, dayOf, dueLabel, labelOf } from '$lib/tasks.js';

	let { path: given }: { path: string } = $props();
	// The parent keys this editor by its path, so it is fixed.
	const path = untrack(() => given);

	const task = createQuery(() => reads.get({ path }));
	const setTask = createMutation(() => writes.set);
	const editTask = createMutation(() => writes.edit);
	const deleteTask = createMutation(() => writes.delete);

	/** The `set`s still on their way, shown over what was last read. */
	const sending = sendingSets();
	const fields = $derived(
		Object.assign({}, task.data, ...sending.filter((input) => input?.path === path)) as TaskChanges,
	);

	/** The title as typed, while it is not sent. */
	let title = $state<string>();
	/** The notes as typed, while they are not saved. */
	let notes = $state<string>();
	/** The body `notes` was typed over, which the edit quotes. */
	let base = '';
	let saved = $state(false);

	const today = dayOf(new Date());
	const shown = (body: string) => body.replace(/\r?\n$/, '');
	const saving = $derived(setTask.isPending || editTask.isPending);

	function set(changes: TaskChanges) {
		setTask.mutate(
			{ path, ...changes },
			{
				onSuccess: () => (saved = true),
				onError: (error) => toast.error('Could not save the task', { description: error.message }),
			},
		);
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	function saveSoon() {
		clearTimeout(timer);
		timer = setTimeout(save, 700);
	}

	/** Send the title and notes typed and not yet sent. */
	function save() {
		clearTimeout(timer);
		if (title !== undefined) {
			const typed = title.trim();
			title = undefined;
			// The sent title shows until the task is read again.
			if (typed !== '' && typed !== task.data?.title) set({ title: typed });
		}
		saveNotes();
	}

	/** Save the notes typed over `base`, quoting it, unless a save is already on its way. */
	function saveNotes() {
		if (notes === undefined || editTask.isPending) return;
		const sent = notes;
		const typed = sent === '' || sent.endsWith('\n') ? sent : `${sent}\n`;
		if (typed === base) {
			notes = undefined;
			return;
		}
		editTask.mutate(
			{ path, old: base, new: typed },
			{
				onSuccess: () => {
					saved = true;
					if (notes === sent) notes = undefined;
					else base = typed;
				},
				onError: (error: ActionError) => {
					if (!changedElsewhere(error))
						return toast.error('Could not save the task', { description: error.message });
					toast.error('The notes changed elsewhere', {
						description: 'Your notes were not saved.',
						action: {
							label: 'Keep mine',
							onClick: () => {
								// The failed edit refreshed the task, so this is the body to replace.
								base = task.data?.body ?? base;
								saveNotes();
							},
						},
					});
				},
			},
		);
	}

	onDestroy(save);

	function confirmDelete() {
		confirmationDialog.open({
			title: `Delete “${labelOf({ path, title: fields.title ?? undefined })}”?`,
			description: 'This deletes the task and its notes.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				clearTimeout(timer);
				title = notes = undefined;
				await deleteTask.mutateAsync({ path });
				toast('Task deleted');
				await goto('#/');
			},
		});
	}
</script>

<svelte:window onpagehide={save} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') save();
	}}
/>

<div class="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
	<header
		class="sticky top-0 z-10 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur"
	>
		<div class="mx-auto flex h-14 max-w-xl items-center gap-2 px-2">
			<Button variant="ghost" href="#/" class="h-11 gap-0.5 pr-3 text-base">
				<ChevronLeftIcon class="size-5" />
				Tasks
			</Button>
			<span class="ml-auto pr-2 text-xs text-muted-foreground" role="status" aria-live="polite">
				{#if saving}Saving…{:else if saved && title === undefined && notes === undefined}Saved{/if}
			</span>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
		{#if task.isPending}
			<div class="flex justify-center py-16" role="status" aria-label="Loading the task">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else if !task.data && task.error?.name === 'Unreachable'}
			<Empty.Root class="py-16">
				<Empty.Title>Epicenter did not answer</Empty.Title>
				<Empty.Description>{task.error.message}</Empty.Description>
				<Button variant="outline" onclick={() => task.refetch()}>Try again</Button>
			</Empty.Root>
		{:else if !task.data}
			<Empty.Root class="py-16">
				<Empty.Title>No task here</Empty.Title>
				<Empty.Description>{task.error?.message || 'It was deleted, here or elsewhere.'}</Empty.Description>
				<Button variant="outline" href="#/">Back to tasks</Button>
			</Empty.Root>
		{:else}
			{@const file = task.data}
			{@const done = fields.done ?? false}
			{@const due = fields.due ?? ''}
			<div class="flex items-start gap-3">
				<Checkbox
					class="mt-3 size-6 rounded-full border-muted-foreground/40"
					aria-label={done ? 'Mark not done' : 'Mark done'}
					bind:checked={() => done, (value) => set({ done: value })}
				/>
				<Textarea
					class="min-h-0 resize-none border-transparent bg-transparent px-1 text-xl font-semibold shadow-none md:text-xl dark:bg-transparent {done
						? 'text-muted-foreground line-through'
						: ''}"
					rows={1}
					placeholder="Title"
					aria-label="Title"
					enterkeyhint="done"
					bind:value={() => title ?? fields.title ?? '',
					(value) => {
						// The title is one line: Enter ends it rather than adding a line.
						title = value.replace(/\r?\n/g, ' ');
						saveSoon();
					}}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget.blur();
						}
					}}
					onblur={save}
				/>
			</div>

			<section class="mt-6" aria-labelledby="due-label">
				<Label id="due-label" for="due" class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
					Due
				</Label>
				<div class="mt-2 flex flex-wrap items-center gap-2">
					<div class="flex items-center gap-1">
						<Input
							id="due"
							type="date"
							class="h-10 w-auto"
							value={due}
							onchange={(event) => {
								const day = event.currentTarget.value;
								set({ due: day === '' ? null : day });
							}}
						/>
						{#if due}
							<IconButton
								label="Clear the due day"
								variant="ghost"
								class="size-10"
								onclick={() => set({ due: null })}
							>
								<XIcon />
							</IconButton>
						{/if}
					</div>
					{#each [{ label: 'Today', day: today }, { label: 'Tomorrow', day: addDays(today, 1) }] as choice (choice.label)}
						<Button
							variant={due === choice.day ? 'secondary' : 'outline'}
							size="sm"
							class="h-10"
							aria-pressed={due === choice.day}
							onclick={() => set({ due: choice.day })}
						>
							{choice.label}
						</Button>
					{/each}
				</div>
				{#if due}
					<p class="mt-1.5 text-xs text-muted-foreground">{dueLabel(due, today)}</p>
				{/if}
			</section>

			<section class="mt-6">
				<Label for="notes" class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
					Notes
				</Label>
				<Textarea
					id="notes"
					class="mt-2 min-h-40 resize-none"
					placeholder="Anything else, in Markdown"
					bind:value={() => notes ?? shown(file.body),
					(value) => {
						if (notes === undefined) base = file.body;
						notes = value;
						saveSoon();
					}}
					onblur={save}
				/>
			</section>

			{#if file.problems}
				<div class="mt-8 text-xs text-muted-foreground" role="note">
					<p>Some of this task's file could not be read:</p>
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
