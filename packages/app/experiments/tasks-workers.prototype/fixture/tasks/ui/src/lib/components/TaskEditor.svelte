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
	import { reads, writes } from '$lib/app.js';
	import { addDays, dayOf, dueLabel } from '$lib/tasks.js';
	let { path: given }: { path: string } = $props();
	const path = untrack(() => given);
	const task = createQuery(() => reads.get({ path }));
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
			toast.dismiss(`set:${path}`);
		},
		onError: (error, variables) =>
			toast.error('Could not save the task', {
				id: `set:${path}`,
				description: error.message,
				action: { label: 'Retry', onClick: () => setTask.mutate(variables) },
			}),
	}));
	const noteTask = createMutation(() => ({
		...writes.note,
		onMutate: () => {
			toast.dismiss(`notes:${path}`);
		},
		onError: (error, variables) =>
			toast.error('Could not save the notes', {
				id: `notes:${path}`,
				description: error.message,
				action: {
					label: 'Retry',
					onClick: () => noteTask.mutate(variables),
				},
			}),
	}));
	const deleteTask = createMutation(() => writes.delete);
	const fields = $derived({ ...task.data, ...(setTask.isPending ? setTask.variables : {}) });
	const busy = $derived(setTask.isPending || deleteTask.isPending);
	let title = $state<string>();
	let titleError = $state('');
	let deleting = $state(false);
	const today = dayOf(new Date());
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
		{:else if (task.error?.name === 'Missing' && task.error.path === path) || (!task.data && !task.error)}
			<Empty.Root class="py-16">
				<Empty.Title>No task here</Empty.Title>
				<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
				<Button variant="outline" href="#/">Back to tasks</Button>
			</Empty.Root>
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
					bind:checked={() => done, (value) => setTask.mutate({ path, done: value })}
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
						setTask.mutate({ path, title: typed });
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
								setTask.mutate({ path, due: day === '' ? null : day });
							}}
						/>
						{#if due}
							<IconButton
								label="Clear the due day"
								variant="ghost"
								class="size-10"
								onclick={() => setTask.mutate({ path, due: null })}
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
							onclick={() => setTask.mutate({ path, due: choice.day })}
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
					value={file.body.replace(/\r?\n$/, '')}
					disabled={noteTask.isPending}
					onblur={(event) => {
						const value = event.currentTarget.value;
						noteTask.mutate({
							path,
							body: value === '' || value.endsWith('\n') ? value : `${value}\n`,
						});
					}}
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

			{#if titleError}<p role="alert" class="mt-2 text-sm text-destructive">{titleError}</p>{/if}

			<div class="mt-10 flex items-center gap-2 border-t pt-4">
				<span class="min-w-0 truncate font-mono text-xs text-muted-foreground">{path}</span>
				<Button variant="destructive" class="ml-auto" onclick={() => { deleteTask.reset(); deleting = true; }}>Delete</Button>
			</div>
			</fieldset>
		{/if}
	</main>
</div>

<AlertDialog.Root bind:open={() => deleting, (next) => { if (!deleteTask.isPending) deleting = next; }}>
	<AlertDialog.Content onEscapeKeydown={(event) => { if (deleteTask.isPending) event.preventDefault(); }}>
		<AlertDialog.Header><AlertDialog.Title>Delete this task?</AlertDialog.Title><AlertDialog.Description>This deletes the task and its notes.</AlertDialog.Description></AlertDialog.Header>
		{#if deleteTask.error}<p role="alert" class="text-sm text-destructive">Could not confirm the deletion: {deleteTask.error.message}</p>{/if}
		<AlertDialog.Footer>
			<AlertDialog.Cancel disabled={deleteTask.isPending}>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action variant="destructive" disabled={deleteTask.isPending} onclick={() => deleteTask.mutate({ path }, { onSuccess: () => { title = undefined; deleting = false; location.hash = '#/'; toast('Task deleted'); } })}>
				{#if deleteTask.isPending}<Spinner class="size-4" />{/if}Delete
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
