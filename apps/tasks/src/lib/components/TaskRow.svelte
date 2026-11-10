<!--
	One task in the list: its check, and its title and due day, which open it.
-->
<script lang="ts">
	import { Checkbox } from '@epicenter/ui/checkbox';
	import { slide } from 'svelte/transition';
	import { dueLabel, isOverdue, labelOf, type Task } from '$lib/tasks.js';

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
	data-id={task.id}
	transition:slide={{ duration: 150 }}
>
	<Checkbox
		class="size-5 rounded-full border-muted-foreground/40"
		bind:checked={() => task.done, (done) => onToggle(task, done)}
		aria-label="{task.done ? 'Mark not done' : 'Mark done'}: {label}"
	/>
	<a
		href="#/t/{task.id}"
		class="flex min-h-12 min-w-0 flex-1 flex-col justify-center py-2 outline-none focus-visible:underline"
	>
		<span
			class="break-anywhere {task.done ? 'text-muted-foreground line-through' : ''}"
		>
			{label}
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
