<!--
	One task in the list: its check, and its title and due day, which open it.
	A task whose file does not fit says so with a small mark; its page says why.
-->
<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { slide } from 'svelte/transition';
	import type { Task } from '$lib/app.js';
	import { dueLabel, hrefOf, isOverdue, labelOf } from '$lib/tasks.js';

	let {
		task,
		today,
		showDue = true,
		onToggle,
	}: {
		task: Task;
		today: string;
		/** Whether to show the due day; the Today group already says it. */
		showDue?: boolean;
		onToggle: (task: Task, done: boolean) => void;
	} = $props();

	const label = $derived(labelOf(task));
</script>

<li
	class="flex items-center gap-3 border-b border-border/60 last:border-b-0"
	data-path={task.path}
	transition:slide={{ duration: 150 }}
>
	<Checkbox
		class="size-5 rounded-full border-muted-foreground/40"
		bind:checked={() => task.done, (done) => onToggle(task, done)}
		aria-label="{task.done ? 'Mark not done' : 'Mark done'}: {label}"
	/>
	<a
		href={hrefOf(task.path)}
		class="flex min-h-12 min-w-0 flex-1 flex-col justify-center py-2 outline-none focus-visible:underline"
	>
		<span
			class="break-anywhere {task.done ? 'text-muted-foreground line-through' : ''}"
		>
			{label}
			{#if task.problems}
				<TriangleAlertIcon
					class="inline size-3.5 align-[-0.125em] text-muted-foreground"
					aria-label="Some of its file could not be read"
				/>
			{/if}
		</span>
		{#if showDue && task.due && !task.done}
			<span
				class="text-xs {isOverdue(task.due, today)
					? 'text-destructive'
					: 'text-muted-foreground'}"
			>
				{dueLabel(task.due, today)}
			</span>
		{/if}
	</a>
</li>
