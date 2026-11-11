<!--
	The task list: a quick add at the top, open tasks grouped by when they are
	due, and the done ones folded away at the bottom.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import type { ActionError } from '@epicenter/app/client';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { type Task, reads, sendingSets, writes } from '$lib/app.js';
	import TaskRow from '$lib/components/TaskRow.svelte';
	import { completed, dayOf, groupOpen, labelOf } from '$lib/tasks.js';

	const tasks = createQuery(() => reads.list());
	const addTask = createMutation(() => writes.add);
	const setTask = createMutation(() => writes.set);

	/** The `set`s still on their way, shown over what was last read. */
	const sending = sendingSets();
	const rows = $derived(
		(tasks.data ?? []).map((task) => {
			const done = sending.findLast((input) => input.path === task.path && input.done != null)?.done;
			return done == null ? task : { ...task, done };
		}),
	);

	let title = $state('');
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

	function add() {
		const typed = title.trim();
		if (typed === '') return;
		// The input clears at once and keeps focus, so the next task can follow.
		title = '';
		addTask.mutate(
			{ title: typed },
			{
				onError: (error) => {
					if (title === '') title = typed;
					toast.error('Could not add the task', { description: error.message });
				},
			},
		);
	}

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
			<h1 class="mb-3 text-2xl font-semibold tracking-tight">Tasks</h1>
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
					placeholder="Add a task"
					aria-label="New task"
					enterkeyhint="done"
					autocomplete="off"
				/>
				<Button
					type="submit"
					size="icon-lg"
					class="size-11"
					aria-label="Add task"
					disabled={title.trim() === ''}
				>
					<PlusIcon />
				</Button>
			</form>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-2 pb-[calc(env(safe-area-inset-bottom)+6rem)]">
		{#if tasks.error}
			<Alert.Root variant="destructive" class="mt-3">
				<Alert.Title>Epicenter did not answer</Alert.Title>
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
					</h2>
					<ul>
						{#each group.tasks as task (task.path)}
							<TaskRow {task} {today} showDue={group.key !== 'today'} onToggle={toggle} />
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
								<TaskRow {task} {today} onToggle={toggle} />
							{/each}
						</ul>
					</Collapsible.Content>
				</Collapsible.Root>
			{/if}
		{/if}
	</main>
</div>
