<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { IconButton } from '$lib/components/ui/icon-button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as AlertDialog from '$lib/components/ui/alert-dialog';
	import * as Empty from '$lib/components/ui/empty';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { toast } from 'svelte-sonner';
	import { Spinner } from '$lib/components/ui/spinner';
	import { Textarea } from '$lib/components/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import XIcon from '@lucide/svelte/icons/x';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import TaskRepair from '$lib/components/TaskRepair.svelte';
	import { reads, writes } from '$lib/app.js';
	import { addDays, dayOf, dueLabel } from '$lib/tasks.js';
	let { id: given }: { id: string } = $props();
	const id = untrack(() => given);
	const task = createQuery(() => reads.get({ id }));

	type Change = { title?: string; done?: boolean; due?: string | null };
	/** Save only the fields the person changed. */
	function save(change: Change) {
		setTask.mutate({ id, ...change });
	}

	const setTask = createMutation(() => ({
		...writes.set,
		onSuccess: async (file, variables, previous, context) => {
			await writes.set.onSuccess(file, variables, previous, context);
			if (variables.title !== undefined && title?.trim() === variables.title) {
				title = undefined;
				titleError = '';
			}
		},
		onMutate: () => {
			toast.dismiss(`set:${id}`);
		},
		onError: (error, { id: _id, ...change }) => {
			toast.error('Could not save the task', {
				id: `set:${id}`,
				description: error.message,
				action: change.title === undefined ? undefined : { label: 'View submitted text', onClick: () => toast('Submitted task', { description: change.title || '(empty)', duration: Infinity }) },
			});
		},
	}));
	const editNotes = createMutation(() => ({
		...writes.edit,
		onSuccess: async (file, variables, previous, context) => {
			await writes.edit.onSuccess(file, variables, previous, context);
			if (notes !== undefined && withEnd(notes) === variables.new) notes = undefined;
		},
		onMutate: () => {
			toast.dismiss(`notes:${id}`);
		},
		onError: (error, variables) => {
			if (error.name === 'Changed')
				toast.error('The notes changed elsewhere', {
					id: `notes:${id}`,
					description: 'Your draft is kept. Save it over them, or show the saved notes.',
					duration: Infinity,
					action: {
						label: 'Save mine',
						onClick: () => {
							notesBase = task.data?.body ?? '';
							saveNotes();
						},
					},
					cancel: { label: 'Show saved', onClick: () => (notes = undefined) },
				});
			else
				toast.error('Could not save the notes', {
					id: `notes:${id}`,
					description: error.message,
					action: { label: 'View submitted text', onClick: () => toast('Submitted notes', { description: variables.new || '(empty)', duration: Infinity }) },
				});
		},
	}));
	const deleteTask = createMutation(() => writes.delete);
	const fields = $derived({ ...task.data, ...(setTask.isPending ? setTask.variables : {}) });
	const busy = $derived(setTask.isPending || deleteTask.isPending);
	let title = $state<string>();
	let titleError = $state('');
	/** The notes being typed, kept until saved; `undefined` shows the saved notes. */
	let notes = $state<string>();
	/** The saved notes when typing began, which `edit` quotes as `old`. */
	let notesBase = '';
	let deleting = $state(false);
	const today = dayOf(new Date());

	/** Notes end with a line break unless they are empty. */
	const withEnd = (text: string) => (text === '' || text.endsWith('\n') ? text : `${text}\n`);

	function saveNotes() {
		if (notes === undefined) return;
		const next = withEnd(notes);
		if (next === notesBase) {
			notes = undefined;
			return;
		}
		editNotes.mutate({ id, old: notesBase, new: next });
	}
</script>
<svelte:window onbeforeunload={(event) => {
	if (title !== undefined) { event.preventDefault(); event.returnValue = ''; }
}} />
<div class="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
	<header
		class="sticky top-0 z-10 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur"
	>
		<div class="mx-auto flex h-14 max-w-xl items-center gap-2 px-2">
			<Button variant="ghost" href="#/" class="h-11 gap-0.5 pr-3 text-base"
			>
				<ChevronLeftIcon class="size-5" />
				Tasks
			</Button>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
		{#if task.isPending}
			<div class="flex justify-center py-16" role="status" aria-label="Loading the task">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else if task.error?.name === 'Missing' || (!task.data && !task.error)}
			<!-- get reads only this task's file, so its Missing is this task. -->
			<Empty.Root class="py-16">
				<Empty.Title>No task here</Empty.Title>
				<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
				<Button variant="outline" href="#/">Back to tasks</Button>
			</Empty.Root>
		{:else if task.error?.name === 'Misfit'}
		<TaskRepair {id} error={task.error} onSaved={() => task.refetch()} />
	{:else if !task.data}
			<Empty.Root class="py-16">
				<Empty.Title>This task could not be loaded</Empty.Title>
				<Empty.Description>{task.error.message}</Empty.Description>
				<Button variant="outline" onclick={() => task.refetch()}>Try again</Button>
			</Empty.Root>
		{:else}
			{@const file = task.data}
			{@const done = fields.done ?? false}
			{@const due = fields.due ?? ''}
			<fieldset disabled={busy} class="min-w-0">
			<div class="flex items-start gap-3">
				<Checkbox
					class="mt-3 size-6 rounded-full border-muted-foreground/40"
					aria-label={done ? 'Mark not done' : 'Mark done'}
					bind:checked={() => done, (value) => save({ done: value })}
				/>
				<Textarea
					class="min-h-12 resize-none border-transparent bg-transparent px-1 text-xl font-semibold shadow-none md:text-xl dark:bg-transparent {done
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
						titleError = '';
					}}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget.blur();
						}
					}}
					onchange={() => {
						if (title === undefined || busy) return;
						const typed = title.trim();
						if (!typed) {
							titleError = 'A task needs a title.';
							return;
						}
						save({ title: typed });
					}}
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
								save({ due: day === '' ? null : day });
							}}
						/>
						{#if due}
							<IconButton
								label="Clear the due day"
								variant="ghost"
								class="size-10"
								onclick={() => save({ due: null })}
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
							onclick={() => save({ due: choice.day })}
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
					value={notes ?? file.body.replace(/\r?\n$/, '')}
					disabled={editNotes.isPending}
					oninput={(event) => {
						if (notes === undefined) notesBase = file.body;
						notes = event.currentTarget.value;
					}}
					onblur={saveNotes}
				/>
			</section>


			{#if titleError}<p role="alert" class="mt-2 text-sm text-destructive">{titleError}</p>{/if}

			<div class="mt-10 flex items-center gap-2 border-t pt-4">
				<span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{file.path}</span>
				<Button variant="destructive" class="ml-auto" onclick={() => { deleteTask.reset(); deleting = true; }}>Delete</Button>
			</div>
			</fieldset>
		{/if}
	</main>
</div>

<AlertDialog.Root bind:open={() => deleting, (next) => { if (!deleteTask.isPending) deleting = next; }}>
	<AlertDialog.Content onEscapeKeydown={(event) => { if (deleteTask.isPending) event.preventDefault(); }}>
		<AlertDialog.Header><AlertDialog.Title>Delete this task?</AlertDialog.Title><AlertDialog.Description>This deletes the task and its notes.</AlertDialog.Description></AlertDialog.Header>
		{#if deleteTask.error}<p role="alert" class="text-sm text-destructive">Could not delete the task: {deleteTask.error.message}</p>{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={deleteTask.isPending}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" disabled={deleteTask.isPending} onclick={() => deleteTask.mutate({ id }, { onSuccess: () => {
				title = undefined; deleting = false; location.hash = '#/'; toast('Task removed');
			} })}>
				{#if deleteTask.isPending}<Spinner class="size-4" />{/if}Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
