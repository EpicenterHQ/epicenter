<script lang="ts">
	import type { ActionError } from '@epicenter/app/client';
	import { createMutation } from '@tanstack/svelte-query';
	import * as Alert from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Spinner } from '$lib/components/ui/spinner';
	import { writes } from '$lib/app.js';

	let { id, error, onSaved }: {
		id: string;
		error: Extract<ActionError, { name: 'Misfit' }>;
		onSaved: () => unknown;
	} = $props();
	const repair = createMutation(() => writes.patch);
</script>

<section>
	<h1 class="text-xl font-semibold">Needs repair</h1>
	<div class="mt-4 text-xs text-muted-foreground" role="note">
		<p>Some of this task's file could not be read:</p>
		<ul class="mt-1 list-disc pl-4 font-mono break-anywhere">
			{#each error.problems as problem}
				<li>{problem.line}</li>
			{/each}
		</ul>
	</div>
	{#if error.record}
		<form class="mt-6" onsubmit={(event) => {
			event.preventDefault();
			const values = new FormData(event.currentTarget);
			repair.mutate({
				id,
				title: String(values.get('title') ?? ''),
				done: values.has('done'),
				due: String(values.get('due') ?? '') || null,
			}, { onSuccess: () => { onSaved(); } });
		}}>
			<fieldset disabled={repair.isPending} class="min-w-0 space-y-6">
				<div class="space-y-2">
					<Label for="repair-title" class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Title</Label>
					<Input id="repair-title" name="title" value={String(error.record.title ?? '')} required class="h-11 text-base" />
				</div>
				<div class="flex items-center gap-3">
					<Checkbox id="repair-done" name="done" checked={error.record.done === true} class="size-6 rounded-full border-muted-foreground/40" />
					<Label for="repair-done">Done</Label>
				</div>
				<div class="space-y-2">
					<Label for="repair-due" class="text-xs font-medium tracking-wide text-muted-foreground uppercase">Due</Label>
					<Input id="repair-due" name="due" type="date" value={String(error.record.due ?? '')} class="h-10 w-auto" />
				</div>
				<Button type="submit" class="h-11">
					{#if repair.isPending}<Spinner class="size-4" />{/if}
					Repair fields
				</Button>
			</fieldset>
		</form>
		<p class="mt-3 text-sm text-muted-foreground">After repairing the fields, you can edit the notes here.</p>
	{:else}
		<p class="mt-6 text-sm text-muted-foreground">The front matter must be repaired in the file before this page can edit it.</p>
	{/if}
	{#if repair.error}
		<Alert.Root variant="destructive" class="mt-4">
			<Alert.Title>{repair.error.name === 'Changed' ? 'This task changed elsewhere' : 'Could not repair the task'}</Alert.Title>
			<Alert.Description>{repair.error.message}</Alert.Description>
		</Alert.Root>
	{/if}
	<p class="mt-10 border-t pt-4 font-mono text-xs text-muted-foreground break-anywhere">{error.path}</p>
</section>
