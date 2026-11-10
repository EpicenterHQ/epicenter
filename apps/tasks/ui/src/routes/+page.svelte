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
	import TaskRow from '$lib/components/TaskRow.svelte';
	import { type Task, tasks } from '$lib/store.svelte.js';
	import { completed, dayOf, groupOpen, labelOf } from '$lib/tasks.js';

	let title = $state('');
	let showCompleted = $state(false);

	// Read once a minute so the groups move on at midnight.
	let now = $state(new Date());
	$effect(() => {
		const timer = setInterval(() => (now = new Date()), 60_000);
		return () => clearInterval(timer);
	});
	const today = $derived(dayOf(now));

	const groups = $derived(groupOpen(tasks.rows(), today));
	const done = $derived(completed(tasks.rows()));

	async function add() {
		const typed = title.trim();
		if (typed === '') return;
		// The input clears at once and keeps focus, so the next task can follow.
		title = '';
		try {
			await tasks.add(typed);
		} catch (error) {
			if (title === '') title = typed;
			toast.error('Could not add the task', { description: String(error) });
		}
	}

	function toggle(task: Task, isDone: boolean) {
		const label = labelOf(task);
		tasks.setDone(task.path, isDone).then(
			() => {
				if (!isDone) return;
				toast(`Done: ${label}`, {
					action: { label: 'Undo', onClick: () => toggle(task, false) },
				});
			},
			(error) =>
				toast.error(`Could not change “${label}”`, { description: String(error) }),
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
					void add();
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
		{#if tasks.problem()}
			<Alert.Root variant="destructive" class="mt-3">
				<Alert.Title>Epicenter did not answer</Alert.Title>
				<Alert.Description>
					<p>{tasks.problem()}</p>
					<Button variant="outline" size="sm" class="mt-2" onclick={() => tasks.refresh()}>
						Try again
					</Button>
				</Alert.Description>
			</Alert.Root>
		{/if}

		{#if !tasks.loaded()}
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
				{#if !tasks.problem()}
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
