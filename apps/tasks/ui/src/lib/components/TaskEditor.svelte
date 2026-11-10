<!--
	One task to edit: whether it is done, its title, its due day, and its
	notes, each saved shortly after it changes, when a field loses focus, and
	when the page is left: the fields through `set`, and the notes through
	`edit`, quoting the notes as loaded, so notes an agent changed meanwhile
	are not overwritten without asking. Delete asks first.
-->
<script lang="ts">
	import { changedElsewhere } from '@epicenter/app/client';
	import { goto } from '$app/navigation';
	import { Button } from '@epicenter/ui/button';
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
	import { onDestroy } from 'svelte';
	import { app, type TaskFile, tasks } from '$lib/store.svelte.js';
	import { addDays, dayOf, dueLabel, labelOf } from '$lib/tasks.js';

	let { id }: { id: string } = $props();

	let phase = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading');
	let problem = $state('');
	let title = $state('');
	let done = $state(false);
	let due = $state('');
	let notes = $state('');
	/** The notes as the server last returned them, which an edit quotes. */
	let base = '';
	let saving = $state(0);
	let unsaved = $state(false);
	let saved = $state(false);

	const today = dayOf(new Date());

	async function load() {
		phase = 'loading';
		try {
			const file = await app.call<TaskFile>('get', { id });
			title = file.title ?? '';
			done = file.done ?? false;
			due = file.due ?? '';
			base = file.body ?? '';
			notes = base.replace(/\r?\n$/, '');
			phase = 'ready';
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
			phase = problem.startsWith('There is no') ? 'missing' : 'failed';
		}
	}
	void load();

	/** Changes typed and not yet sent. */
	let queued: Record<string, unknown> = {};
	let timer: ReturnType<typeof setTimeout> | undefined;

	function change(fields: Record<string, unknown>, wait = 700) {
		Object.assign(queued, fields);
		unsaved = true;
		clearTimeout(timer);
		timer = setTimeout(save, wait);
	}

	async function save() {
		clearTimeout(timer);
		if (Object.keys(queued).length === 0) return;
		const sent = queued;
		queued = {};
		saving++;
		const { body, ...fields } = sent;
		let left: Record<string, unknown> = sent;
		try {
			// Fields merge; the notes are an edit quoting what was loaded, so notes changed elsewhere are never overwritten.
			if (Object.keys(fields).length > 0) {
				tasks.changed(await app.call<TaskFile>('set', { id, ...fields }));
				left = body === undefined ? {} : { body };
			}
			if (body !== undefined && body !== base) {
				const file = await app.call<TaskFile>('edit', { id, old: base, new: body });
				base = file.body ?? '';
				tasks.changed(file);
			}
			left = {};
			unsaved = Object.keys(queued).length > 0;
			saved = true;
		} catch (error) {
			if (changedElsewhere(error)) {
				toast.error('The notes changed elsewhere', {
					description: 'Your notes were not saved.',
					action: { label: 'Keep mine', onClick: () => void keepMine(body as string) },
				});
			} else {
				queued = { ...left, ...queued };
				toast.error('Could not save the task', { description: String(error) });
			}
		} finally {
			saving--;
		}
	}

	/** Replace notes changed elsewhere with the ones typed here, after the person chose to. */
	async function keepMine(body: string) {
		try {
			base = (await app.call<TaskFile>('get', { id })).body ?? '';
			change({ body }, 0);
		} catch (error) {
			toast.error('Could not save the task', { description: String(error) });
		}
	}

	onDestroy(() => void save());

	function confirmDelete() {
		confirmationDialog.open({
			title: `Delete “${labelOf({ id, title })}”?`,
			description: 'This deletes the task and its notes.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				clearTimeout(timer);
				queued = {};
				await tasks.remove(id);
				toast('Task deleted');
				await goto('#/');
			},
		});
	}
</script>

<svelte:window onpagehide={() => void save()} />
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void save();
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
				{#if saving > 0}Saving…{:else if saved && !unsaved}Saved{/if}
			</span>
		</div>
	</header>

	<main class="mx-auto max-w-xl px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
		{#if phase === 'loading'}
			<div class="flex justify-center py-16" role="status" aria-label="Loading the task">
				<Spinner class="size-5 text-muted-foreground" />
			</div>
		{:else if phase === 'missing'}
			<Empty.Root class="py-16">
				<Empty.Title>This task is gone</Empty.Title>
				<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
				<Button variant="outline" href="#/">Back to tasks</Button>
			</Empty.Root>
		{:else if phase === 'failed'}
			<Empty.Root class="py-16">
				<Empty.Title>Epicenter did not answer</Empty.Title>
				<Empty.Description>{problem}</Empty.Description>
				<Button variant="outline" onclick={load}>Try again</Button>
			</Empty.Root>
		{:else}
			<div class="flex items-start gap-3">
				<Checkbox
					class="mt-3 size-6 rounded-full border-muted-foreground/40"
					aria-label={done ? 'Mark not done' : 'Mark done'}
					bind:checked={() => done,
					(value) => {
						done = value;
						change({ done: value }, 0);
					}}
				/>
				<Textarea
					class="min-h-0 resize-none border-transparent bg-transparent px-1 text-xl font-semibold shadow-none md:text-xl dark:bg-transparent {done
						? 'text-muted-foreground line-through'
						: ''}"
					rows={1}
					placeholder="Title"
					aria-label="Title"
					enterkeyhint="done"
					bind:value={() => title,
					(value) => {
						// The title is one line: Enter ends it rather than adding a line.
						title = value.replace(/\r?\n/g, ' ');
						if (title.trim() !== '') change({ title: title.trim() });
					}}
					onkeydown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							event.currentTarget.blur();
						}
					}}
					onblur={() => void save()}
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
								due = event.currentTarget.value;
								change({ due: due === '' ? null : due }, 0);
							}}
						/>
						{#if due}
							<Button
								variant="ghost"
								size="icon"
								class="size-10"
								aria-label="Clear the due day"
								onclick={() => {
									due = '';
									change({ due: null }, 0);
								}}
							>
								<XIcon />
							</Button>
						{/if}
					</div>
					{#each [{ label: 'Today', day: today }, { label: 'Tomorrow', day: addDays(today, 1) }] as choice (choice.label)}
						<Button
							variant={due === choice.day ? 'secondary' : 'outline'}
							size="sm"
							class="h-10"
							aria-pressed={due === choice.day}
							onclick={() => {
								due = choice.day;
								change({ due: choice.day }, 0);
							}}
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
					bind:value={() => notes,
					(value) => {
						notes = value;
						change({ body: value === '' || value.endsWith('\n') ? value : `${value}\n` });
					}}
					onblur={() => void save()}
				/>
			</section>

			<div class="mt-10 flex items-center gap-2 border-t pt-4">
				<span class="min-w-0 truncate font-mono text-xs text-muted-foreground">tasks/{id}.md</span>
				<Button variant="ghost-destructive" class="ml-auto" onclick={confirmDelete}>Delete</Button>
			</div>
		{/if}
	</main>
</div>
