<!--
	One note to edit: its title and Markdown body, saved after a pause, when
	a field loses focus, on Cmd/Ctrl+S, and when the page is left. The title
	saves through `set`; the body through `edit`, quoting it as loaded. A
	change elsewhere keeps the person's draft and asks whether to keep theirs
	or use the saved version. Leaving that choice offers Keep mine in a toast.
-->
<script lang="ts">
	import { ActionError, changedElsewhere } from '@epicenter/app/client';
	import { goto } from '$app/navigation';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Empty from '@epicenter/ui/empty';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import LinkIcon from '@lucide/svelte/icons/link';
	import { onDestroy, untrack } from 'svelte';
	import { app, type NoteFile, notes } from '$lib/notes.svelte.js';
	import { captureHref, captureTime, labelOf } from '$lib/notes.js';

	let { path: given }: { path: string } = $props();
	// The parent keys this editor by its path, so it is fixed.
	const path = untrack(() => given);
	let phase = $state<'loading' | 'missing' | 'refused' | 'failed' | 'ready'>('loading');
	let problem = $state('');
	let title = $state('');
	let body = $state('');
	let capture = $state<string>();
	let problems = $state<string[]>();
	let conflict = $state.raw<NoteFile>();
	let conflictProblem = $state('');
	let saving = $state(false);
	let unsaved = $state(false);
	let saved = $state(false);
	let failed = $state(false);
	let titleInput = $state<HTMLInputElement>();
	let bodyInput = $state<HTMLTextAreaElement | null>(null);
	/** The body last returned by the server, quoted by the next edit. */
	let base = '';
	let savedTitle = '';
	let stopped = false;
	let leaving = false;
	let checking = false;
	let revision = 0;
	let running: Promise<void> | undefined;
	type Changes = { title?: string | null; body?: string };
	let queued: Changes = {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	const capturedAt = $derived(capture ? captureTime(capture) : undefined);

	function adopt(file: NoteFile) {
		title = file.title ?? '';
		savedTitle = title;
		body = file.body;
		base = file.body;
		capture = file.capture;
		problems = file.problems;
	}

	async function load() {
		phase = 'loading';
		try {
			const file = await app.get({ path });
			if (stopped) return;
			adopt(file);
			phase = 'ready';
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
			phase =
				error instanceof ActionError && error.kind === 'transport'
					? 'failed'
					: problem.startsWith('There is no')
						? 'missing'
						: 'refused';
		}
	}
	const loading = load();

	$effect(() => {
		if (phase === 'ready' && notes.isFresh(path)) titleInput?.focus();
	});

	function change(fields: Changes, wait: number) {
		revision++;
		Object.assign(queued, fields);
		unsaved = true;
		failed = false;
		clearTimeout(timer);
		if (!conflict && !conflictProblem) timer = setTimeout(() => void save(), wait);
	}

	/** One save at a time; a request during a save drains the draft that follows it. */
	async function save(): Promise<void> {
		clearTimeout(timer);
		if (running) {
			await running;
			return save();
		}
		if (
			stopped ||
			phase !== 'ready' ||
			conflict ||
			conflictProblem ||
			Object.keys(queued).length === 0
		) {
			return;
		}
		running = flush();
		await running;
		running = undefined;
	}

	async function flush() {
		const sent = queued;
		queued = {};
		saving = true;
		revision++;
		const { body: draft, ...fields } = sent;
		let left: Changes = sent;
		try {
			if ('title' in fields) {
				const file = await app.set({ path, ...fields });
				savedTitle = file.title ?? '';
				capture = file.capture;
				problems = file.problems;
				notes.changed(file);
				left = draft === undefined ? {} : { body: draft };
			}
			if (draft !== undefined && draft !== base) {
				const file = await app.edit({ path, old: base, new: draft });
				base = file.body;
				capture = file.capture;
				problems = file.problems;
				notes.changed(file);
			}
			saved = true;
			failed = false;
		} catch (error) {
			queued = { ...left, ...queued };
			failed = true;
			if (changedElsewhere(error)) {
				// Block autosaving even if getting the changed file fails.
				conflictProblem = 'Loading the version saved elsewhere…';
				await readConflict();
			} else toast.error('Could not save the note', { description: String(error) });
		} finally {
			saving = false;
			unsaved = Object.keys(queued).length > 0;
		}
	}

	async function readConflict() {
		try {
			conflict = await app.get({ path });
			conflictProblem = '';
		} catch (error) {
			conflictProblem = String(error);
		}
	}

	function keepMine() {
		if (!conflict) return;
		base = conflict.body;
		conflict = undefined;
		conflictProblem = '';
		queued = { ...queued, body };
		void save();
	}

	function useTheirs() {
		if (!conflict) return;
		adopt(conflict);
		notes.changed(conflict);
		queued = {};
		conflict = undefined;
		conflictProblem = '';
		unsaved = false;
		failed = false;
		saved = true;
		revision++;
	}

	/** Adopt changes made elsewhere only while this editor has no unfinished work. */
	async function follow() {
		if (
			stopped ||
			leaving ||
			checking ||
			phase !== 'ready' ||
			document.visibilityState !== 'visible' ||
			unsaved ||
			saving ||
			conflict ||
			conflictProblem
		) {
			return;
		}
		checking = true;
		const before = revision;
		try {
			const file = await app.get({ path });
			if (
				stopped ||
				leaving ||
				before !== revision ||
				unsaved ||
				saving ||
				conflict ||
				conflictProblem
			) {
			return;
		}
			if (
				file.body !== base ||
				(file.title ?? '') !== savedTitle ||
				file.capture !== capture ||
				JSON.stringify(file.problems) !== JSON.stringify(problems)
			) {
				adopt(file);
				notes.changed(file);
			}
		} catch {
			// Keep the readable draft; the next focus or poll asks again.
		} finally {
			checking = false;
		}
	}

	$effect(() => {
		const interval = setInterval(() => void follow(), 10_000);
		return () => clearInterval(interval);
	});

	onDestroy(() => {
		leaving = true;
		clearTimeout(timer);
		// A quick Back can leave before the first read. Finish that read before
		// deciding whether the fresh note is empty, or saving its draft.
		void (async () => {
			await loading;
			if (running) await running;
			if (
				!conflict &&
				!conflictProblem &&
				notes.isFresh(path) &&
				phase === 'ready' &&
				title === '' &&
				body === ''
			) {
				stopped = true;
				try {
					await notes.remove(path);
				} catch (error) {
					toast.error('Could not remove the empty note', { description: String(error) });
				}
			} else {
				// The asynchronous save keeps owning this draft after its view leaves.
				await save();
				if ((conflict || conflictProblem) && Object.keys(queued).length > 0) {
					const draft = { ...queued, body };
					toast.error(`Your edits to “${labelOf({ title })}” were not saved`, {
						description: 'The note changed elsewhere.',
						action: {
							label: 'Keep mine',
							async onClick() {
								try {
									const fresh = await app.get({ path });
									if ('title' in draft) {
										notes.changed(await app.set({ path, title: draft.title }));
									}
									notes.changed(
										await app.edit({ path, old: fresh.body, new: draft.body }),
									);
								} catch (error) {
									toast.error('Could not save the note', { description: String(error) });
								}
							},
						},
					});
				}
				stopped = true;
			}
		})();
	});

	function confirmDelete() {
		confirmationDialog.open({
			title: `Delete “${labelOf({ title })}”?`,
			description: 'This deletes the note.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				clearTimeout(timer);
				stopped = true;
				if (running) await running;
				try {
					await notes.remove(path);
					queued = {};
					toast('Note deleted');
					await goto('#/');
				} catch (error) {
					stopped = false;
					toast.error('Could not delete the note', { description: String(error) });
				}
			},
		});
	}
</script>

<svelte:window
	onpagehide={() => void save()}
	onfocus={() => void follow()}
	onkeydown={(event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
			event.preventDefault();
			void save();
		}
	}}
/>
<svelte:document
	onvisibilitychange={() => {
		if (document.visibilityState === 'hidden') void save();
		else void follow();
	}}
/>

<header class="sticky top-0 z-10 border-b bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur">
	<div class="flex min-h-14 items-center gap-2 px-3">
		<Button variant="ghost" href="#/" class="h-11 md:hidden">
			<ChevronLeftIcon class="size-5" />
			Notes
		</Button>
		<span
			class="ml-auto text-xs text-muted-foreground"
			role="status"
			aria-live="polite"
		>
			{#if saving}
				Saving…
			{:else if failed}
				Not saved
			{:else if unsaved}
				Unsaved
			{:else if saved}
				Saved
			{/if}
		</span>
		{#if unsaved}
			<Button
				variant="outline"
				class="h-11"
				disabled={saving || !!conflict || !!conflictProblem}
				onclick={() => void save()}
			>
				Save
			</Button>
		{/if}
		{#if phase === 'ready'}
			<Button variant="ghost-destructive" class="h-11" onclick={confirmDelete}>Delete</Button>
		{/if}
	</div>
</header>
<main class="mx-auto max-w-3xl px-4 pt-6 pb-[calc(env(safe-area-inset-bottom)+2rem)] md:px-8">
	{#if phase === 'loading'}
		<div class="flex justify-center py-16" role="status" aria-label="Loading the note">
			<Spinner class="size-5 text-muted-foreground" />
		</div>
	{:else if phase === 'missing'}
		<Empty.Root class="py-16">
			<Empty.Title>This note is gone</Empty.Title>
			<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
			<Button variant="outline" href="#/">Back to notes</Button>
		</Empty.Root>
	{:else if phase === 'refused'}
		<Empty.Root class="py-16">
			<Empty.Title>No note here</Empty.Title>
			<Empty.Description>{problem}</Empty.Description>
			<Button variant="outline" href="#/">Back to notes</Button>
		</Empty.Root>
	{:else if phase === 'failed'}
		<Empty.Root class="py-16">
			<Empty.Title>Epicenter did not answer</Empty.Title>
			<Empty.Description>{problem}</Empty.Description>
			<Button variant="outline" onclick={load}>Try again</Button>
		</Empty.Root>
	{:else}
		<input
			bind:this={titleInput}
			class="min-h-11 w-full border-0 bg-transparent text-3xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground"
			aria-label="Title"
			placeholder="Untitled"
			value={title}
			oninput={(event) => {
				title = event.currentTarget.value.replace(/[\r\n]/g, '');
				change({ title: title.trim() || null }, 800);
			}}
			onkeydown={(event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					bodyInput?.focus();
				}
			}}
			onblur={() => void save()}
		/>
		{#if capture}
			<div class="mt-3 space-y-1 text-sm text-muted-foreground">
				<p>
					<LinkIcon class="mr-1 inline size-4" />Developed from a capture
					{#if capturedAt}
						· {capturedAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
					{/if}
				</p>
				<a
					href={captureHref(capture)}
					target="_self"
					class="inline-flex min-h-11 items-center underline underline-offset-4"
				>
					Open in Capture
				</a>
				<p class="font-mono text-xs break-anywhere">{capture}</p>
			</div>
		{/if}
		{#if conflict || conflictProblem}
			<Alert.Root class="mt-6">
				<Alert.Title>This note changed elsewhere</Alert.Title>
				<Alert.Description>
					<p>
						Your latest edits are not saved. Keep yours to save them over the other change,
						or use the version saved elsewhere.
					</p>
					{#if conflict}
						<div class="mt-2 flex gap-2">
							<Button class="h-11" onclick={keepMine}>Keep mine</Button>
							<Button variant="outline" class="h-11" onclick={useTheirs}>Use theirs</Button>
						</div>
					{:else}
						<p>{conflictProblem}</p>
						<Button variant="outline" class="mt-2 h-11" onclick={readConflict}>Try again</Button>
					{/if}
				</Alert.Description>
			</Alert.Root>
		{/if}
		<Textarea
			bind:ref={bodyInput}
			class="mt-6 min-h-[60dvh] resize-none border-0 bg-transparent px-0 text-base leading-7 shadow-none field-sizing-content focus-visible:ring-0 md:text-base dark:bg-transparent"
			aria-label="Body in Markdown"
			placeholder="Write in Markdown"
			bind:value={() => body,
				(value) => {
					body = value;
					change({ body: value }, 1500);
				}}
			onblur={() => void save()}
		/>
		{#if problems}
			<div class="mt-8 text-xs text-muted-foreground" role="note">
				<p>Some of this note's file could not be read:</p>
				<ul class="mt-1 list-disc pl-4 font-mono break-anywhere">
					{#each problems as line (line)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}
		<footer class="mt-10 border-t pt-4 font-mono text-xs break-anywhere text-muted-foreground">
			{path}
		</footer>
	{/if}
</main>
