<!--
	One capture: its text and its thoughts, read from the file's body with the
	body codec, and each change saved through `edit`.

	Every change is shown at once, then made in order against the file as the
	server has it now: the change reads the file again, applies itself to
	that, and writes with `edit` quoting the body it read, so a change that
	lands in between refuses the write and the change is applied again. Text another program changed in the meantime is not
	overwritten without asking, and a thought is changed only when the list
	is still the one the person saw. When a save fails, the file is shown as
	it is and what was typed stays in its box. When the file has something
	that does not fit a capture, such as a capturedAt that is not a time, a
	note under the date quotes it.

	The parent keys this view by `path`.
-->
<script lang="ts">
	import { ActionError, changedElsewhere } from '@epicenter/app/client';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as DropdownMenu from '@epicenter/ui/dropdown-menu';
	import * as Empty from '@epicenter/ui/empty';
	import * as InputGroup from '@epicenter/ui/input-group';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { toast } from '@epicenter/ui/sonner';
	import { Textarea } from '@epicenter/ui/textarea';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { type CaptureBody, type CaptureBodyReading, captureBody } from '$lib/body/document.js';
	import { app, type CaptureFile, captures, messageOf } from '$lib/captures.svelte.js';
	import { instantOf } from '$lib/days.js';
	import { hasKeyboard } from '$lib/keys.js';
	import { whileVisible } from '$lib/visible.js';

	let { path }: { path: string } = $props();
	const args = untrack(() => ({ path }));

	let file = $state.raw<CaptureFile>();
	let status = $state<'loading' | 'ready' | 'gone' | 'refused' | 'failed'>('loading');
	let problem = $state<string>();

	const reading = $derived(file && captureBody.decode(file.body));
	const current = $derived(reading?.data ?? undefined);
	const capturedAt = $derived(instantOf(file?.capturedAt));
	const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });

	/** The text as typed, while it differs from the file's. */
	let text = $state<string>();
	const isTextChanged = $derived(text !== undefined && text !== current?.text);
	/** The whole body as typed in Edit as Markdown, while that is open. */
	let markdown = $state<string>();
	let newThought = $state('');
	let editing = $state<{ index: number; text: string; shown: string[] }>();
	let changes = $state(0);

	async function load() {
		try {
			file = await app.get(args);
			status = 'ready';
			problem = undefined;
		} catch (error) {
			if (error instanceof ActionError && error.kind === 'threw' && error.message.includes('There is no'))
				status = 'gone';
			else if (error instanceof ActionError && error.kind !== 'transport' && file === undefined) {
				status = 'refused';
				problem = messageOf(error);
			} else if (file === undefined) {
				status = 'failed';
				problem = messageOf(error);
			}
		}
	}

	// Ask again while the page is visible, unless something here is being typed or saved.
	$effect(() =>
		whileVisible(() => {
			if (changes === 0 && !isTextChanged && editing === undefined && markdown === undefined) void load();
		}),
	);

	/** The text shown when the file changed elsewhere while it was being changed here. */
	const CHANGED = 'It changed elsewhere while you were editing. It now shows the latest version; try again.';

	let queue: Promise<unknown> = Promise.resolve();

	/**
	 * Shows `next` applied to the capture now, then, after the changes before
	 * it, applies it to the file as the server has it and writes that. `next`
	 * returns why it cannot apply, as a sentence, when the file has moved on.
	 * Resolves whether it was saved.
	 */
	function change(what: string, next: (latest: CaptureBodyReading) => CaptureBody | string): Promise<boolean> {
		if (file && current) {
			const value = next(current);
			const shown = typeof value === 'string' ? undefined : captureBody.encode(value, file.body).data;
			if (shown) file = { ...file, body: shown };
		}
		changes += 1;
		const run = queue.then(async () => {
			let latest: CaptureFile | undefined;
			try {
				// edit quotes the body it read, so a change landing in between refuses it; read again and reapply.
				for (let attempt = 1; ; attempt++) {
					latest = await app.get(args);
					const read = captureBody.decode(latest.body);
					const value = read.error ? read.error.message : next(read.data);
					if (typeof value === 'string') {
						file = latest;
						toast.error(`${what} not saved`, { description: value });
						return false;
					}
					const encoded = captureBody.encode(value, latest.body);
					if (encoded.error) {
						file = latest;
						toast.error(`${what} not saved`, { description: encoded.error.message });
						return false;
					}
					try {
						file = await app.edit({ ...args, old: latest.body, new: encoded.data });
					} catch (error) {
						if (changedElsewhere(error) && attempt < 3) continue;
						throw error;
					}
					captures.saved(args.path, value.text.trim(), value.thoughts.length);
					return true;
				}
			} catch (error) {
				toast.error(`${what} not saved`, { description: messageOf(error) });
				if (latest) file = latest;
				else void load();
				return false;
			} finally {
				changes -= 1;
			}
		});
		queue = run;
		return run;
	}

	const same = (a: readonly string[], b: readonly string[]) =>
		a.length === b.length && a.every((thought, index) => thought === b[index]);

	async function saveText() {
		const typed = text;
		const base = current?.text;
		if (typed === undefined || base === undefined || typed === base) return;
		const saved = await change('Text', (latest) =>
			latest.text === base || latest.text === typed
				? { text: typed, thoughts: latest.thoughts }
				: 'Its text changed elsewhere while you were editing. Your version is still in the box; save again to replace what is there now.',
		);
		if (saved && text === typed) text = undefined;
	}

	async function addThought() {
		const typed = newThought;
		if (typed.trim() === '') return;
		newThought = '';
		const saved = await change('Thought', (latest) => ({
			text: latest.text,
			thoughts: [...latest.thoughts, typed],
		}));
		if (!saved && newThought === '') newThought = typed;
	}

	async function saveThought() {
		if (editing === undefined) return;
		const { index, shown, text: typed } = editing;
		editing = undefined;
		if (typed === shown[index]) return;
		if (typed.trim() === '') return deleteThought(index, shown);
		await change('Thought', (latest) =>
			same(latest.thoughts, shown)
				? { text: latest.text, thoughts: shown.map((thought, at) => (at === index ? typed : thought)) }
				: CHANGED,
		);
	}

	function deleteThought(index: number, shown: string[]) {
		void change('Deletion', (latest) =>
			same(latest.thoughts, shown)
				? { text: latest.text, thoughts: shown.filter((_, at) => at !== index) }
				: CHANGED,
		);
	}

	async function saveMarkdown() {
		const typed = markdown;
		const base = file?.body;
		if (typed === undefined || base === undefined) return;
		changes += 1;
		const run = queue.then(async () => {
			try {
				try {
					file = await app.edit({ ...args, old: base, new: typed });
				} catch (error) {
					if (!changedElsewhere(error)) throw error;
					file = await app.get(args);
					toast.error('Not saved', {
						description: 'The file changed elsewhere while you were editing. Your version is still in the box; save again to replace what is there now.',
					});
					return;
				}
				const read = captureBody.decode(file.body);
				if (read.data) captures.saved(args.path, read.data.text.trim(), read.data.thoughts.length);
				if (markdown === typed) markdown = undefined;
			} catch (error) {
				toast.error('Not saved', { description: messageOf(error) });
			} finally {
				changes -= 1;
			}
		});
		queue = run;
		await run;
	}

	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			toast.success('Copied');
		} catch {
			toast.error('Could not copy. Select the text and copy it.');
		}
	}

	function confirmDelete() {
		confirmationDialog.open({
			title: 'Delete this capture?',
			description: 'Its file and every thought on it are deleted. Its history stays in Git.',
			confirm: { text: 'Delete', variant: 'destructive' },
			async onConfirm() {
				try {
					await captures.delete(args.path);
				} catch (error) {
					toast.error('Not deleted', { description: messageOf(error) });
					throw error;
				}
				await goto('#/');
				toast.success('Capture deleted');
			},
		});
	}

	/** Enter submits on a computer; Shift+Enter, and Return on a touch screen, start a new line. Escape runs `cancel`. */
	function submitKeys(submit: () => void, cancel?: () => void) {
		return (event: KeyboardEvent) => {
			if (event.key === 'Escape' && cancel) {
				event.preventDefault();
				cancel();
			}
			if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
			if (!(event.metaKey || event.ctrlKey || hasKeyboard())) return;
			event.preventDefault();
			submit();
		};
	}

	/** Focuses `node` and puts the caret at its end. */
	function focusEnd(node: HTMLTextAreaElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}
</script>

<div class="flex flex-col gap-6">
	<div class="flex items-center gap-2">
		<Button href="#/" variant="ghost" size="sm" class="-ml-2.5">
			<ChevronLeftIcon />
			Captures
		</Button>
		<span class="ml-auto text-xs text-muted-foreground" aria-live="polite">
			{#if changes > 0}Saving…{/if}
		</span>
		{#if status === 'ready'}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-sm" aria-label="More for this capture">
							<EllipsisIcon />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-52">
					<DropdownMenu.Item disabled={!current} onclick={() => current && void copy(current.text)}>Copy text</DropdownMenu.Item>
					<DropdownMenu.Item onclick={() => (markdown = file?.body ?? '')}>Edit as Markdown</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onclick={confirmDelete}>Delete capture…</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</div>

	{#if status === 'loading'}
		<div class="flex flex-col gap-4" aria-busy="true" aria-label="Loading capture">
			<Skeleton class="h-5 w-56" />
			<Skeleton class="h-32 w-full" />
		</div>
	{:else if status === 'gone'}
		<Empty.Root>
			<Empty.Header>
				<Empty.Title>This capture is gone</Empty.Title>
				<Empty.Description>It was deleted, here or elsewhere.</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button href="#/" variant="outline" size="sm">Back to captures</Button></Empty.Content>
		</Empty.Root>
	{:else if status === 'refused'}
		<Empty.Root>
			<Empty.Header>
				<Empty.Title>No capture here</Empty.Title>
				<Empty.Description>{problem}</Empty.Description>
			</Empty.Header>
			<Empty.Content><Button href="#/" variant="outline" size="sm">Back to captures</Button></Empty.Content>
		</Empty.Root>
	{:else if status === 'failed'}
		<Alert.Root variant="destructive">
			<Alert.Title>Can't reach Epicenter</Alert.Title>
			<Alert.Description>
				<p>{problem}</p>
				<Button variant="outline" size="sm" class="mt-2" onclick={() => void load()}>Try again</Button>
			</Alert.Description>
		</Alert.Root>
	{:else if file}
		<h1 class="text-sm text-muted-foreground">
			{#if capturedAt}
				<time datetime={capturedAt.toISOString()}>{when.format(capturedAt)}</time>
			{:else}
				A capture with no date
			{/if}
		</h1>

		{#if file.problems}
			<div class="-mt-4 text-xs text-muted-foreground" role="note">
				<p>Some of this capture's file could not be read:</p>
				<ul class="mt-1 list-disc pl-4 font-mono break-words">
					{#each file.problems as line (line)}
						<li>{line}</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if markdown !== undefined}
			<form
				class="flex flex-col gap-3"
				onsubmit={(event) => {
					event.preventDefault();
					void saveMarkdown();
				}}
			>
				<Textarea
					bind:value={markdown}
					aria-label="The capture's Markdown"
					class="min-h-64 font-mono text-sm leading-relaxed"
					spellcheck="false"
				/>
				<p class="text-xs text-muted-foreground">
					The body of <code>{args.path}</code>. Its text comes first, then its thoughts as a list under <code>## Thoughts</code>.
				</p>
				<div class="flex justify-end gap-2">
					<Button variant="ghost" size="sm" onclick={() => (markdown = undefined)}>Cancel</Button>
					<Button type="submit" size="sm">Save</Button>
				</div>
			</form>
		{:else if reading?.error}
			<Alert.Root>
				<Alert.Title>This capture can only be edited as Markdown</Alert.Title>
				<Alert.Description>
					<p>{reading.error.message}</p>
					<Button variant="outline" size="sm" class="mt-2" onclick={() => (markdown = file?.body ?? '')}>Edit as Markdown</Button>
				</Alert.Description>
			</Alert.Root>
		{:else if current}
			<form
				class="flex flex-col gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					void saveText();
				}}
			>
				<Textarea
					bind:value={() => text ?? current.text, (typed) => (text = typed)}
					aria-label="Capture text"
					placeholder="Empty capture"
					class="min-h-32 text-base leading-relaxed md:text-base"
					onblur={() => void saveText()}
					onkeydown={(event) => {
						if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
							event.preventDefault();
							void saveText();
						}
						if (event.key === 'Escape' && isTextChanged) text = undefined;
					}}
				/>
				<div class="flex min-h-8 items-center justify-end gap-2">
					{#if isTextChanged}
						<span class="mr-auto text-xs text-muted-foreground">Saves when you leave the box</span>
						<!-- Pressing it keeps focus in the box, so leaving the box does not save first. -->
						<Button variant="ghost" size="sm" onpointerdown={(event) => event.preventDefault()} onclick={() => (text = undefined)}>Discard</Button>
						<Button type="submit" size="sm">Save</Button>
					{/if}
				</div>
			</form>

			<section class="flex flex-col gap-3" aria-labelledby="thoughts-heading">
				<h2 id="thoughts-heading" class="text-sm font-medium">
					Thoughts
					{#if current.thoughts.length}<span class="font-normal text-muted-foreground">{current.thoughts.length}</span>{/if}
				</h2>

				{#if current.thoughts.length}
					{@const shown = current.thoughts}
					<ol class="flex flex-col divide-y border-y">
						{#each shown as thought, index (index)}
							<li class="py-2">
								{#if editing?.index === index}
									<form
										class="flex flex-col gap-2"
										onsubmit={(event) => {
											event.preventDefault();
											void saveThought();
										}}
									>
										<Textarea
											bind:value={editing.text}
											aria-label="Thought {index + 1}"
											class="text-base leading-relaxed md:text-base"
											{@attach focusEnd}
											onkeydown={submitKeys(() => void saveThought(), () => (editing = undefined))}
										/>
										<div class="flex justify-end gap-2">
											<Button variant="ghost" size="sm" onclick={() => (editing = undefined)}>Cancel</Button>
											<Button type="submit" size="sm">Save</Button>
										</div>
									</form>
								{:else}
									<div class="flex items-start gap-2">
										<p class="min-w-0 flex-1 py-1 leading-relaxed break-words whitespace-pre-wrap">{thought}</p>
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button {...props} variant="ghost" size="icon-sm" class="text-muted-foreground" aria-label="More for thought {index + 1}">
														<EllipsisIcon />
													</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end" class="w-44">
												<DropdownMenu.Item onclick={() => (editing = { index, text: thought, shown: [...shown] })}>Edit</DropdownMenu.Item>
												<DropdownMenu.Item onclick={() => void copy(thought)}>Copy</DropdownMenu.Item>
												<DropdownMenu.Separator />
												<DropdownMenu.Item
													variant="destructive"
													onclick={() => {
														const list = [...shown];
														confirmationDialog.open({
															title: 'Delete this thought?',
															description: thought.length > 200 ? `${thought.slice(0, 200)}…` : thought,
															confirm: { text: 'Delete', variant: 'destructive' },
															onConfirm: () => deleteThought(index, list),
														});
													}}
												>
													Delete…
												</DropdownMenu.Item>
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									</div>
								{/if}
							</li>
						{/each}
					</ol>
				{/if}

				<form
					onsubmit={(event) => {
						event.preventDefault();
						void addThought();
					}}
				>
					<InputGroup.Root>
						<InputGroup.Textarea
							bind:value={newThought}
							aria-label="Add a thought"
							placeholder="Add a thought"
							rows={1}
							class="min-h-10 leading-relaxed"
							onkeydown={submitKeys(() => void addThought())}
						/>
						<InputGroup.Addon align="inline-end" class="self-end pb-1.5">
							<InputGroup.Button type="submit" size="icon-sm" variant="ghost" disabled={newThought.trim() === ''} aria-label="Add thought">
								<PlusIcon />
							</InputGroup.Button>
						</InputGroup.Addon>
					</InputGroup.Root>
				</form>

				{#if current.hasOtherContent}
					<p class="text-xs text-muted-foreground">This file has more Markdown after its thoughts, kept as it is. Edit as Markdown shows it.</p>
				{/if}
			</section>
		{/if}
	{/if}
</div>
