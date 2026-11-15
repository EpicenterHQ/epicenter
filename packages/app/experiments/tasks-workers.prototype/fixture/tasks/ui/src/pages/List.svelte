<!--
	The task list: a quick add at the top, open tasks grouped by when they are
	due, and the done ones folded away at the bottom.
-->
<script lang="ts">
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { IconButton } from '$lib/components/ui/icon-button';
	import * as Collapsible from '$lib/components/ui/collapsible';
	import * as Empty from '$lib/components/ui/empty';
	import { Input } from '$lib/components/ui/input';
	import { toast } from 'svelte-sonner';
	import { Spinner } from '$lib/components/ui/spinner';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { ActionError } from '@epicenter/app/client';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { type Task, reads, writes } from '$lib/app.js';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import { completed, dayOf, groupOpen, labelOf } from '$lib/tasks.js';

	const tasks = createQuery(() => reads.list());
	const addTask = createMutation(() => writes.add);
	const setTask = createMutation(() => writes.set);

 const rows = $derived((tasks.data ?? []).map((task) => setTask.isPending && setTask.variables?.path === task.path ? { ...task, done: setTask.variables.done ?? task.done } : task));

	let showCompleted = $state(false);

	// Read once a minute so the groups move on at midnight.
	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(timer);
	});
	const today = $derived(dayOf(now));

	const groups = $derived(groupOpen(rows, today));
	const done = $derived(completed(rows));

	/** Each row's change settles its own promise, so quick ticks on several rows each get their toast. */
	function toggle(task: Task, isDone: boolean) {
		const label = labelOf(task);
		setTask.mutateAsync({ path: task.path, done: isDone }).then(
			() => {
				if (!isDone) return;
				toast(`Done: ${label}`, {
					action: { label: 'Undo', onClick: () => toggle(task, false) },
				});
			},
			(error: ActionError) =>
				toast.error(`Could not change “${label}”`, { description: error.message }),
		);
	}
</script>

<div class="min-h-dvh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
	<header
		class="sticky top-0 z-10 border-b bg-background/85 pt-[env(safe-area-inset-top)] backdrop-blur"
	>
		<div class="mx-auto max-w-xl px-4 pt-4 pb-3">
			<div class="mb-3 flex items-baseline justify-between gap-2">
				<h1 class="text-2xl font-semibold tracking-tight">Tasks</h1>
				<span role="status" class="text-xs text-muted-foreground">{addTask.isPending || setTask.isPending ? 'Saving…' : ''}</span>
			</div>
			<form
				class="flex flex-wrap gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					const form = event.currentTarget;
					const data = new FormData(form);
					const title = String(data.get('title') ?? '').trim();
					if (title === '') return;
					const due = String(data.get('due') ?? '');
					addTask.mutate({ title, ...(due ? { due } : {}) }, {
						onSuccess: () => { form.reset(); (form.elements.namedItem('title') as HTMLInputElement).focus(); },
						onError: (error) => toast.error('Could not add the task', { description: error.message }),
					});
				}}
			>
				<Input
					name="title"
					required
 readonly={addTask.isPending}
					class="h-11 flex-1 basis-40 text-base"
					placeholder="Add a task"
					aria-label="New task"
					enterkeyhint="done"
					autocomplete="off"
				/>
				<Input
					type="date"
					name="due"
 readonly={addTask.isPending}
					aria-label="New task due date"
					class="order-3 h-11 w-full sm:order-none sm:w-36"
				/>
				<IconButton
					label="Add task"
					size="lg"
					type="submit"
					class="size-11"
					disabled={addTask.isPending}
				>
					<PlusIcon />
				</IconButton>
			</form>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+6rem)]">
		{#if tasks.error}
			<Alert.Root variant="destructive" class="mt-3">
				<Alert.Title>Your tasks could not be loaded</Alert.Title>
				<Alert.Description>
					<p>{tasks.error.message}</p>
					<Button variant="outline" size="sm" class="mt-2" onclick={() => tasks.refetch()}>
						Try again
					</Button>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if tasks.isPending}
			<div class="flex justify-center py-16" role="status" aria-label="Loading tasks">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else}
			{#each groups as group (group.key)}
				<section class="mt-4" aria-labelledby="group-{group.key}">
					<h2
						id="group-{group.key}"
						class="text-xs font-medium tracking-wide uppercase {group.key === 'overdue'
							? 'text-destructive'
							: 'text-muted-foreground'}"
					>
						{group.label}
						<span class="ml-1 tabular-nums">{group.tasks.length}</span>
					</h2>
					<ul>
						{#each group.tasks as task (task.path)}
							<TaskRow {task} {today} showDue={group.key !== 'today'} onToggle={toggle} disabled={setTask.isPending} />
						{/each}
					</ul>
				</section>
			{:else}
				{#if !tasks.error}
					<Empty.Root class="py-16">
						<Empty.Title>Nothing to do</Empty.Title>
						<Empty.Description>Add a task above, or ask your agent to.</Empty.Description>
					</Empty.Root>
				{/if}
			{/each}

			{#if done.length > 0}
				<Collapsible.Root bind:open={showCompleted} class="mt-6">
					<Collapsible.Trigger
						class="flex min-h-11 w-full items-center gap-1 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
					>
						<ChevronRightIcon
							class="size-4 transition-transform {showCompleted ? 'rotate-90' : ''}"
						/>
						Completed
						<span class="ml-1 tabular-nums">{done.length}</span>
					</Collapsible.Trigger>
					<Collapsible.Content>
						<ul>
							{#each done as task (task.path)}
								<TaskRow {task} {today} onToggle={toggle} disabled={setTask.isPending} />
							{/each}
						</ul>
					</Collapsible.Content>
				</Collapsible.Root>
			{/if}
		{/if}
	</main>
</div>
