<script lang="ts">
	import type { CalendarDateString } from '@epicenter/field';
	import { Badge } from '@epicenter/ui/badge';
	import { Button, buttonVariants } from '@epicenter/ui/button';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Empty from '@epicenter/ui/empty';
	import { Input } from '@epicenter/ui/input';
	import * as Item from '@epicenter/ui/item';
	import { NaturalLanguageCalendarDateInput } from '@epicenter/ui/natural-language-date-input';
	import * as Popover from '@epicenter/ui/popover';
	import { Textarea } from '@epicenter/ui/textarea';
	import CalendarIcon from '@lucide/svelte/icons/calendar';
	import CheckIcon from '@lucide/svelte/icons/check';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TagIcon from '@lucide/svelte/icons/tag';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import XIcon from '@lucide/svelte/icons/x';
	import { todosState } from '$lib/todos/client';
	import type { ContextSlug, Todo } from '../../todos';

	let title = $state('');
	let body = $state('');
	let dueDate = $state<CalendarDateString | null>(null);
	let dueOpen = $state(false);
	let pickedContexts = $state<ContextSlug[]>([]);
	let contextOpen = $state(false);

	// Default a new todo's contexts to whichever context is being viewed, so
	// adding a task from inside a context tags it; "All" starts with none.
	$effect(() => {
		const viewing = todosState.selectedContextId;
		pickedContexts = viewing ? [viewing] : [];
	});

	function togglePicked(slug: ContextSlug) {
		pickedContexts = pickedContexts.includes(slug)
			? pickedContexts.filter((existing) => existing !== slug)
			: [...pickedContexts, slug];
	}

	const COLOR_DOT: Record<string, string> = {
		sky: 'bg-sky-500',
		violet: 'bg-violet-500',
		emerald: 'bg-emerald-500',
	};

	function dotClass(color: string | null | undefined): string {
		return (color && COLOR_DOT[color]) || 'bg-muted-foreground';
	}

	function formatDueDate(value: string): string {
		const [year, month, day] = value.split('-').map(Number);
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
		}).format(new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1));
	}

	async function createTodo(event: SubmitEvent) {
		event.preventDefault();
		if (!title.trim()) return;
		await todosState.createTodo({
			title,
			body,
			dueDate,
			contexts: pickedContexts,
		});
		title = '';
		body = '';
		dueDate = null;
		pickedContexts = todosState.selectedContextId
			? [todosState.selectedContextId]
			: [];
	}

</script>

{#snippet todoCard(todo: Todo, done: boolean)}
	<article
		class="group/todo border-border bg-card flex items-start gap-3 rounded-lg border px-3 py-2.5 shadow-xs"
	>
		<Checkbox
			checked={done}
			onCheckedChange={(checked: boolean) =>
				void todosState.toggleTodo(todo.id, checked === true)}
			aria-label={done ? `Reopen ${todo.title}` : `Complete ${todo.title}`}
			class="mt-0.5 shrink-0"
		/>
		<div class="min-w-0 flex-1">
			<h3
				class="truncate text-sm font-medium {done
					? 'text-muted-foreground line-through'
					: ''}"
			>
				{todo.title}
			</h3>
			{#if todo.body}
				<p class="text-muted-foreground mt-0.5 line-clamp-2 text-sm">
					{todo.body}
				</p>
			{/if}
			{#if todo.dueDate || todo.contexts.length > 0}
				<div class="mt-2 flex flex-wrap items-center gap-1.5">
					{#if todo.dueDate}
						<Badge variant="secondary" class="gap-1">
							<CalendarIcon class="size-3" />
							{formatDueDate(todo.dueDate)}
						</Badge>
					{/if}
					{#each todo.contexts as slug (slug)}
						{@const context = todosState.contextFor(slug)}
						<Badge variant={context ? 'secondary' : 'outline'} class="gap-1.5">
							{#if context}
								<span class="size-1.5 rounded-full {dotClass(context.color)}"></span>
							{/if}
							{todosState.contextLabel(slug)}
						</Badge>
					{/each}
				</div>
			{/if}
		</div>
		<Button
			variant="ghost"
			size="icon-sm"
			tooltip="Delete todo"
			class="text-muted-foreground shrink-0 opacity-0 transition-opacity group-hover/todo:opacity-100 focus-visible:opacity-100"
			onclick={() => void todosState.softDeleteTodo(todo.id)}
		>
			<Trash2Icon class="size-4" />
		</Button>
	</article>
{/snippet}

<main class="min-h-screen bg-background text-foreground">
	<div class="grid min-h-screen lg:grid-cols-[18rem_minmax(0,1fr)]">
		<aside
			class="border-border/70 border-b bg-muted/20 p-4 lg:border-r lg:border-b-0"
		>
			<div class="mb-6 flex items-center gap-2">
				<div
					class="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground"
				>
					<InboxIcon class="size-4" />
				</div>
				<div>
					<h1 class="text-base font-semibold">To-do's</h1>
					<p class="text-muted-foreground text-xs">epicenter.todos</p>
				</div>
			</div>

			<nav class="space-y-0.5">
				<Button
					variant={todosState.selectedContextId === null ? 'secondary' : 'ghost'}
					class="h-9 w-full justify-start gap-2"
					onclick={() => todosState.selectContext(null)}
				>
					<InboxIcon class="text-muted-foreground size-4 shrink-0" />
					<span class="flex-1 text-left">All</span>
					<span class="text-muted-foreground text-xs tabular-nums">
						{todosState.openTodos.length}
					</span>
				</Button>
				{#each todosState.contexts as context (context.id)}
					<Button
						variant={todosState.selectedContextId === context.id
							? 'secondary'
							: 'ghost'}
						class="h-9 w-full justify-start gap-2"
						onclick={() => todosState.selectContext(context.id)}
					>
						<span class="flex size-4 shrink-0 items-center justify-center">
							<span class="size-2 rounded-full {dotClass(context.color)}"></span>
						</span>
						<span class="min-w-0 flex-1 truncate text-left">{context.name}</span>
						<span class="text-muted-foreground text-xs tabular-nums">
							{todosState.contextCount(context.id)}
						</span>
					</Button>
				{/each}
			</nav>
		</aside>

		<section class="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 sm:p-6">
			<header>
				<h2 class="text-xl font-semibold tracking-tight">
					{todosState.selectedContextId
						? todosState.contextLabel(todosState.selectedContextId)
						: 'All open'}
				</h2>
				<p class="text-muted-foreground text-sm">
					{todosState.selectedOpenTodos.length} open, {todosState
						.selectedCompletedTodos.length} done
				</p>
			</header>

			<form
				class="border-border bg-card focus-within:border-ring rounded-lg border shadow-xs transition-colors"
				onsubmit={createTodo}
			>
				<Input
					bind:value={title}
					placeholder="Add a task"
					aria-label="Task title"
					class="h-10 border-0 bg-transparent px-3 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<Textarea
					bind:value={body}
					placeholder="Notes"
					aria-label="Notes"
					class="min-h-9 resize-none border-0 bg-transparent px-3 py-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent"
				/>
				<div
					class="border-border/60 flex items-center justify-between gap-2 border-t p-2"
				>
					<div class="flex items-center gap-1">
						<Popover.Root bind:open={dueOpen}>
							<Popover.Trigger
								class="{buttonVariants({
									variant: 'ghost',
									size: 'sm',
								})} text-muted-foreground gap-2"
							>
								<CalendarIcon class="size-4" />
								{dueDate ? formatDueDate(dueDate) : 'Due date'}
							</Popover.Trigger>
							<Popover.Content align="start" class="w-72 p-0">
								<NaturalLanguageCalendarDateInput
									onChoice={({ date }) => {
										dueDate = date;
										dueOpen = false;
									}}
								/>
							</Popover.Content>
						</Popover.Root>
						{#if dueDate}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								tooltip="Clear date"
								onclick={() => (dueDate = null)}
							>
								<XIcon class="size-4" />
							</Button>
						{/if}
						<Popover.Root bind:open={contextOpen}>
							<Popover.Trigger
								class="{buttonVariants({
									variant: 'ghost',
									size: 'sm',
								})} text-muted-foreground gap-2"
							>
								<TagIcon class="size-4" />
								{#if pickedContexts.length === 0}
									Context
								{:else if pickedContexts.length === 1}
									{todosState.contextLabel(pickedContexts[0]!)}
								{:else}
									{pickedContexts.length} contexts
								{/if}
							</Popover.Trigger>
							<Popover.Content align="start" class="w-56 p-1">
								<div class="grid gap-0.5">
									{#each todosState.contexts as context (context.id)}
										<Item.Button
											size="sm"
											class="hover:bg-accent gap-2 px-2 py-1.5"
											onclick={() => togglePicked(context.id)}
										>
											<Item.Media>
												<span
													class="size-2 shrink-0 rounded-full {dotClass(
														context.color,
													)}"
												></span>
											</Item.Media>
											<Item.Content>
												<span class="truncate text-left">{context.name}</span>
											</Item.Content>
											{#if pickedContexts.includes(context.id)}
												<CheckIcon class="size-4 shrink-0" />
											{/if}
										</Item.Button>
									{/each}
								</div>
							</Popover.Content>
						</Popover.Root>
					</div>
					<Button type="submit" size="sm" disabled={!title.trim()}>
						<PlusIcon class="size-4" />
						Add
					</Button>
				</div>
			</form>

			<div class="grid gap-2">
				{#each todosState.selectedOpenTodos as todo (todo.id)}
					{@render todoCard(todo, false)}
				{:else}
					<Empty.Root class="py-12">
						<Empty.Media variant="icon">
							<InboxIcon />
						</Empty.Media>
						<Empty.Title>All clear</Empty.Title>
						<Empty.Description>Add a task to get started.</Empty.Description>
					</Empty.Root>
				{/each}
			</div>

			{#if todosState.selectedCompletedTodos.length > 0}
				<section class="grid gap-2">
					<h3
						class="text-muted-foreground text-xs font-medium tracking-wide uppercase"
					>
						Completed
					</h3>
					{#each todosState.selectedCompletedTodos as todo (todo.id)}
						{@render todoCard(todo, true)}
					{/each}
				</section>
			{/if}
		</section>
	</div>
</main>
