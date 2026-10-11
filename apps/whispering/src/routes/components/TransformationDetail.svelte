<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import * as Field from '@epicenter/ui/field';
	import * as Popover from '@epicenter/ui/popover';
	import * as Select from '@epicenter/ui/select';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import { Loading } from '@epicenter/ui/loading';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { parseRow, rowStemOf } from '@epicenter/folder';
	import { withFileNewlines } from '@epicenter/folder/file-browser';
	import { wellFormed } from '@epicenter/folder';
	import { tick, untrack } from 'svelte';
	import { TRANSFORMATIONS, whisperingDefinition } from '$lib/definition.js';
	import type { Draft, Library, TextRun, TransformationEntry } from '$lib/library.svelte.js';
	import { recipeEndpoint } from '$lib/recipe.js';
	import { committedState } from '$lib/status.js';
	import { confirmDelete, copyText, formatTime, lf, openItem, recordingTitle } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
	import SaveBar from '@epicenter/svelte/save-bar';
	import SettingsForm from './SettingsForm.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	let {
		library,
		path,
		draft,
		entry,
		applyTo = $bindable(),
		applySource = $bindable(),
		pastedText = $bindable(),
		tryItFor = $bindable(),
		onBack,
		onOpenFile,
	}: {
		library: Library;
		path: string;
		/** The open draft of the transformation's file: its fields, or its text. */
		draft: Draft;
		/** The listed row, or undefined when the file left the folder. */
		entry: TransformationEntry | undefined;
		/** The transcription this is tried on, by row path. Kept by the session across pages. */
		applyTo: string | undefined;
		/** Whether this is tried on a saved transcript or on pasted text. Kept by the session. */
		applySource: 'transcript' | 'pasted';
		/** The pasted text. Kept by the session, so it stays across pages and transformations. */
		pastedText: string;
		/** A transformation asked to show Try it, by row path. Kept by the session; this clears it when it is this one. */
		tryItFor?: string | undefined;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
		onOpenFile: (path: string) => void;
	} = $props();

	const row = $derived(draft.kind === 'row' && draft.table === TRANSFORMATIONS ? draft.session : undefined);
	const source = $derived(draft.kind === 'text' ? draft.session : undefined);
	/** The text on screen read as a recipe, or why it does not read. */
	const parsed = $derived(source && parseRow(whisperingDefinition.tables.transformations, source.draft));
	const issues = $derived(parsed?.error ?? undefined);
	/** The recipe as typed: the fields' draft, or the text when it reads. */
	const recipe = $derived(row?.draft ?? parsed?.data ?? undefined);
	const text = (key: 'title' | 'model' | 'endpoint') => recipe?.fields[key] ?? '';
	const id = $derived(rowStemOf(TRANSFORMATIONS, path) ?? path);
	/** The one decision about this recipe, as it is typed; Run saves it and decides again. */
	const resolved = $derived(library.resolve(recipe));
	const connection = $derived(library.connections?.text);
	const constraint = $derived(recipe && recipeEndpoint(recipe.fields));
	/** Saved results on transcripts and on pasted text, newest first. */
	const outputs = $derived(
		[
			...library.outputsOf(id).map((item) => ({ source: 'transcript' as const, entry: item })),
			...library.textOutputsOf(id).map((item) => ({ source: 'text' as const, entry: item })),
		].sort((a, b) => b.entry.row.fields.createdAt.localeCompare(a.entry.row.fields.createdAt)),
	);
	const history = $derived(entry ? committedState(library.git, [entry.path]) : undefined);
	/** The model a run would use: this transformation's own, or the text connection's. */
	const model = $derived(text('model').trim() || connection?.model.trim() || undefined);
	/** Whether the model and connection notes are open; a fix that needs them opens them. */
	let notesOpen = $state(false);
	let connectionOpen = $state(false);

	/**
	 * Saved transcripts with text, newest first, named by their recording. Any
	 * recording offers its transcripts, whatever its file is named and whatever
	 * else in its file needs fixing.
	 */
	const transcripts = $derived(
		library.entries.flatMap((recording) =>
			library
				.resultsFor(recording.stem)
				.filter((result) => result.row.body.trim() !== '')
				.map((result) => ({
					result,
					label: `${recordingTitle(recording)} · ${formatTime(result.row.fields.createdAt, 'short')}`,
				})),
		),
	);
	const chosen = $derived(transcripts.find((item) => item.result.path === applyTo));
	const running = $derived(
		library.transformationRuns.some((run) => run.fields.transformationId === id && run.state.kind === 'running'),
	);
	/** This recipe's run on pasted text that is not a saved result: running, failed, or waiting for Save. */
	const textRun = $derived<TextRun | undefined>(library.textRuns.find((run) => run.fields.transformationId === id));
	/** Authoring comes first, unless a result on pasted text is waiting here to be saved or retried. */
	// Workflow selection within the fields view; the draft says whether Source shows.
	let tab = $state<'instructions' | 'try'>(untrack(() => textRun) ? 'try' : 'instructions');
	$effect(() => {
		if (issues) tab = 'instructions';
	});
	let editor = $state<HTMLElement | null>(null);
	let tabTriggers = $state<Record<'instructions' | 'try', HTMLElement | null>>({ instructions: null, try: null });
	/** Where focus was when this editor first saw the request for Try it, while it waits to show it. */
	let requestedFrom: Element | null | undefined;
	// Open to save or discard asks for Try it, whether this editor was already
	// showing or opens for it. Only that request moves the tab; a run changing
	// state never does. An editor still opening has no tabs, so the request
	// waits for them and is taken once.
	$effect.pre(() => {
		if (tryItFor !== path) return;
		if (requestedFrom === undefined) requestedFrom = document.activeElement;
		if (draft.kind === 'loading') return;
		const from = requestedFrom;
		requestedFrom = undefined;
		tryItFor = undefined;
		tab = 'try';
		void focusTab('try', from);
	});
	/** What focus can move to when the control that had it goes away. */
	let runButtons = $state<Record<'transcript' | 'pasted', HTMLElement | null>>({ transcript: null, pasted: null });
	let goToInstructionsButton = $state<HTMLElement | null>(null);
	let blockedReason = $state<HTMLElement | null>(null);
	/** Why Run is unavailable, in the order a person would fix it, or undefined when it can run. */
	const blocked = $derived.by(() => {
		if (entry === undefined) return 'This transformation is not in the folder.';
		// Running settles its saves first, so what has to be sound is the text as typed.
		if (resolved.kind === 'blocked') return resolved.reason;
		if (applySource === 'pasted') {
			if (textRun?.state.kind === 'running') return 'Running on pasted text…';
			if (textRun?.state.kind === 'unsaved') return 'Save or discard the result below before running this again.';
			if (pastedText.trim() === '') return 'Paste some text to run this on.';
			return undefined;
		}
		if (transcripts.length === 0) return 'Transcribe a recording first, or paste text to run this on.';
		if (chosen === undefined) return 'Choose a transcript to run this on.';
		return undefined;
	});
	/** What a person fixes when the library's decision is what blocks Run. */
	const fix = $derived(entry !== undefined && resolved.kind === 'blocked' ? resolved.fix : undefined);

	async function run() {
		const problem =
			applySource === 'pasted'
				? await library.transformText(path, pastedText)
				: chosen && (await library.transform(chosen.result.path, path));
		if (problem) toast.error('The transformation did not run', { description: problem });
	}

	async function save(run: TextRun) {
		const from = document.activeElement;
		await library.saveTextRun(run.id);
		const after = library.textRuns.find((item) => item.id === run.id);
		if (after?.state.kind === 'unsaved' && after.state.message)
			toast.error('The result was not saved', { description: after.state.message });
		if (after !== undefined) return;
		await tick();
		// Save leaves with the held result. Keep any focus the person moved elsewhere.
		if (from && !from.isConnected && editor?.isConnected && tab === 'try' && document.activeElement === document.body)
			tabTriggers.try?.focus();
	}

	function discard(run: TextRun) {
		if (run.state.kind !== 'unsaved') {
			library.discardTransformationRun(run.id);
			return;
		}
		confirmationDialog.open({
			title: 'Discard this result?',
			description: 'The text held in this window is dropped. Running the transformation again calls the endpoint again.',
			confirm: { text: 'Discard', variant: 'destructive' },
			onConfirm: () => library.discardTransformationRun(run.id),
		});
	}

	/**
	 * Focus a tab once it shows. Focus that is nowhere, still where the action
	 * started, or already in this editor is the action's to move; focus the
	 * person has put anywhere else stays there.
	 */
	async function focusTab(name: 'instructions' | 'try', from: Element | null) {
		await tick();
		const focused = document.activeElement;
		if (focused === null || focused === document.body || focused === from || editor?.contains(focused))
			tabTriggers[name]?.focus();
	}

	/** Show Instructions with the model notes open. The button pressed leaves with Try it, so focus moves to the tab. */
	async function goToInstructions() {
		const from = document.activeElement;
		const problem = await library.useForm(path);
		if (problem) {
			toast.error('The fields were not opened', { description: problem });
			return;
		}
		tab = 'instructions';
		notesOpen = true;
		void focusTab('instructions', from);
	}

	/**
	 * The text connection's settings close on their own when saving them
	 * changes why Run is unavailable, and take the focused form with them. Focus
	 * goes to Run when it can run now, or else to what still stops it, unless
	 * something else has taken focus meanwhile. `from` is what had focus in the
	 * settings as they closed.
	 */
	$effect.pre(() => {
		if (!connectionOpen || fix === 'connection') return;
		const from = document.activeElement;
		connectionOpen = false;
		if (from === null || from === document.body || from.closest('[data-slot="popover-content"]'))
			void focusAfterConnectionSaved(from);
	});

	async function focusAfterConnectionSaved(from: Element | null) {
		await tick();
		const focused = document.activeElement;
		if (focused !== null && focused !== document.body && focused !== from) return;
		(blocked === undefined ? runButtons[applySource] : (goToInstructionsButton ?? blockedReason))?.focus();
	}

	/** Show the fields or the whole text. Answers whether it switched. */
	async function show(asSource: boolean) {
		const problem = asSource ? await library.editSource(path) : await library.useForm(path);
		if (problem) toast.error(asSource ? 'The text was not opened for editing' : 'The fields were not opened', { description: problem });
		return problem === undefined;
	}
</script>

<section bind:this={editor} class="flex h-full min-h-0 flex-col" aria-label="Transformation" data-testid="transformation-detail">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to transformations" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if row}
			<Input
				class="flex-1 text-base font-medium"
				bind:value={
					() => row?.draft.fields.title ?? '',
					(value) =>
						row?.edit((draft) => {
							draft.fields.title = wellFormed(value);
						})
				}
				disabled={row.locked}
				placeholder="Title"
				aria-label="Transformation title"
				data-testid="transformation-title"
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium" data-testid="transformation-title-text">{text('title') || id}</h2>
		{/if}
		{#if history === 'uncommitted'}
			<Badge variant="outline">Saved · not in history yet</Badge>
		{:else if history === 'committed'}
			<Badge variant="secondary">In history</Badge>
		{/if}
	</div>

	{#if draft.kind === 'row' || draft.kind === 'text'}
		<SaveBar
			save={draft.session.state}
			review={draft.session.review}
			onRetry={() => draft.session.retry()}
			onResolve={(choices) => library.resolveReview(draft.session, choices)}
		/>
	{/if}

	{#if issues}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This text does not read as a transformation yet. Fix it in Source; it saves as you type.
			</p>
			<ul class="space-y-0.5 text-muted-foreground">
				{#each issues as issue, index (index)}
					<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if draft.kind === 'loading'}
		<Loading class="flex-1" label="Opening the transformation…" />
	{:else if draft.kind === 'failed'}
		<div class="flex flex-1 flex-col items-start gap-2 px-4 py-4 text-sm" role="alert" data-testid="row-unopened">
			<p>This transformation’s file could not be opened: {draft.message}</p>
			<Button size="sm" variant="outline" onclick={() => void openItem(library, path)}>Try again</Button>
		</div>
	{:else}
	<Tabs.Root bind:value={
		() => tab === 'try' ? 'try' : source ? 'source' : 'instructions',
		(value) => {
			if (value === 'try') {
				tab = 'try';
				return;
			}
			void show(value === 'source').then((shown) => {
				if (shown) tab = 'instructions';
			});
		}
	} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger bind:ref={tabTriggers.instructions} value="instructions" disabled={issues !== undefined} data-testid="tab-instructions">Instructions</Tabs.Trigger>
			<Tabs.Trigger bind:ref={tabTriggers.try} value="try" data-testid="tab-try">
				Try it
				{#if running || textRun?.state.kind === 'running'}
					<Spinner class="size-3" aria-label="Running" />
				{:else if textRun?.state.kind === 'failed'}
					<Badge variant="destructive">Failed</Badge>
				{:else if textRun?.state.kind === 'unsaved'}
					<Badge variant="secondary">Not saved</Badge>
				{/if}
			</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="instructions" class="min-h-0 flex-1 overflow-y-auto">
			<div class="flex flex-col gap-4 py-1">
				{#if constraint}
					<Alert.Root variant="warning" data-testid="transformation-endpoint-constraint">
						<Alert.Title>Runs only at {constraint}</Alert.Title>
						<Alert.Description class="flex flex-col gap-2">
							<p>
								An earlier version saved this endpoint in the transformation. It runs only while the text connection is exactly
								that endpoint; the request always goes to the connection.
							</p>
							{#if row}
								<Button
									size="xs"
									variant="outline"
									class="self-start"
									disabled={row.locked}
									onclick={() =>
										row?.edit((draft) => {
											draft.fields.endpoint = null;
										})}
									data-testid="remove-endpoint-constraint"
								>
									Remove the endpoint and use the text connection
								</Button>
							{/if}
						</Alert.Description>
					</Alert.Root>
				{/if}

				<Field.Field>
					<Field.Label for="transformation-prompt">Instructions</Field.Label>
					{#if row}
						<Textarea
							id="transformation-prompt"
							class="min-h-36 resize-y font-sans"
							bind:value={
								() => lf(row?.draft.body ?? ''),
								(value) =>
									row?.edit((draft) => {
										draft.body = withFileNewlines(wellFormed(value), draft.body);
									})
							}
							disabled={row.locked}
							placeholder="Say what to do with the text, such as: Fix punctuation and remove filler words. Answer with the text only."
							data-testid="transformation-prompt"
						/>
					{/if}
					<Field.Description>Sent first. The transcript or pasted text follows, unchanged.</Field.Description>
				</Field.Field>

				<Collapsible.Root bind:open={notesOpen}>
					<Collapsible.Trigger>
						{#snippet child({ props })}
							<Button {...props} variant="ghost" size="sm" class="group -ml-2 max-w-full text-muted-foreground" data-testid="transformation-notes">
								<ChevronRightIcon class="transition-transform group-aria-expanded:rotate-90 motion-reduce:transition-none" />
								Model and connection
								<span class={['truncate font-normal', (library.connectionsProblem || !connection || !model) && 'text-destructive']}>
									· {model ?? 'no model named'} ·
									{library.connectionsProblem ? 'the text connection could not be read' : (connection?.baseUrl ?? 'no text connection')}
								</span>
							</Button>
						{/snippet}
					</Collapsible.Trigger>
					<Collapsible.Content class="flex flex-col gap-4 pt-2">
						<Field.Field>
							<Field.Label for="transformation-model">Model (optional)</Field.Label>
							{#if row}
								<Input
									id="transformation-model"
									bind:value={
										() => row?.draft.fields.model ?? '',
										(value) =>
											row?.edit((draft) => {
												// An empty model uses the text connection's model.
												draft.fields.model = value.trim() === '' ? null : wellFormed(value);
											})
									}
									disabled={row.locked}
									placeholder={connection?.model ? `The text connection’s model: ${connection.model}` : 'The text connection’s model'}
									autocomplete="off"
									spellcheck={false}
									data-testid="transformation-model"
								/>
							{:else}
								<p class="text-sm" data-testid="transformation-model-text">{text('model') || 'The text connection’s model'}</p>
							{/if}
							<Field.Description>
								Leave empty to use the text connection’s model. Typed exactly as the endpoint names it; Whispering keeps no list of models.
							</Field.Description>
						</Field.Field>
						<div class="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="transform-note">
							{#if connection}
								<p>Sends to the text connection: {connection.baseUrl}{connection.keyPresent ? ', with its key' : ', with no key'}.</p>
							{:else if library.connectionsProblem}
								<p class="text-destructive">The text connection could not be read: {library.connectionsProblem}</p>
							{:else}
								<p>No text connection is set up. Set one up in Settings to run this.</p>
							{/if}
							<p>{library.workspace.transformNote}</p>
							<p>
								A result on a transcript is saved as a new file in <code class="font-mono">transformation_runs/</code>. A result on
								pasted text is saved in <code class="font-mono">text_runs/</code> when you save it. The text it came from is never
								changed.
							</p>
						</div>
					</Collapsible.Content>
				</Collapsible.Root>
			</div>
		</Tabs.Content>
		<Tabs.Content value="try" class="min-h-0 flex-1 overflow-y-auto">
			<div class="flex flex-col gap-5 py-1">
				<div class="flex flex-col gap-2">
					<Tabs.Root
						value={applySource}
						onValueChange={(next) => (applySource = next === 'pasted' ? 'pasted' : 'transcript')}
						class="flex flex-col gap-2"
					>
						<Tabs.List class="self-start" aria-label="Run it on">
							<Tabs.Trigger value="transcript" data-testid="apply-transcript">A transcript</Tabs.Trigger>
							<Tabs.Trigger value="pasted" data-testid="apply-pasted">Pasted text</Tabs.Trigger>
						</Tabs.List>
						<Tabs.Content value="transcript" class="flex flex-col gap-2">
							<div class="flex flex-wrap items-center gap-2">
								<Select.Root type="single" bind:value={() => applyTo ?? '', (value) => (applyTo = value || undefined)}>
									<Select.Trigger class="min-w-0 flex-1" aria-label="Transcript to transform" disabled={transcripts.length === 0} data-testid="transformation-input">
										<span class="truncate">{chosen?.label ?? (transcripts.length === 0 ? 'No saved transcripts yet' : 'Choose a transcript')}</span>
									</Select.Trigger>
									<Select.Content>
										<Select.Group>
											{#each transcripts as item (item.result.path)}
												<Select.Item value={item.result.path} label={item.label} />
											{/each}
										</Select.Group>
									</Select.Content>
								</Select.Root>
								<Button
									bind:ref={runButtons.transcript}
									disabled={blocked !== undefined || running}
									onclick={() => void run()}
									data-testid="run-transformation"
								>
									{#if running}<Spinner class="size-3.5" />{:else}<PlayIcon />{/if}
									Run
								</Button>
							</div>
							{#if !blocked && chosen}
								<p class="max-h-24 overflow-y-auto rounded border p-2 text-xs whitespace-pre-wrap text-muted-foreground">{chosen.result.row.body.trim()}</p>
								<p class="text-xs text-muted-foreground">
									Run saves your edits, then sends the instructions and this transcript. The answer is saved as a new result below; the
									transcript does not change.
								</p>
							{/if}
						</Tabs.Content>
						<Tabs.Content value="pasted" class="flex flex-col gap-2">
							<Textarea
								class="min-h-28 resize-y font-sans"
								bind:value={pastedText}
								placeholder="Paste text to try this on. It stays here while you move between pages and transformations, and is not saved anywhere."
								aria-label="Text to transform"
								data-testid="pasted-text"
							/>
							<div class="flex flex-wrap items-center gap-2">
								<Button bind:ref={runButtons.pasted} disabled={blocked !== undefined} onclick={() => void run()} data-testid="run-pasted">
									{#if textRun?.state.kind === 'running'}<Spinner class="size-3.5" />{:else}<PlayIcon />{/if}
									Run on pasted text
								</Button>
								{#if !blocked}
									<span class="text-xs text-muted-foreground">
										Run saves your edits, then sends the instructions and this text. The answer waits here until you save it.
									</span>
								{/if}
							</div>
						</Tabs.Content>
					</Tabs.Root>

					<!-- Why Run is unavailable, with the one action that fixes it when it is here. -->
					{#if blocked}
						<div class="flex flex-wrap items-center gap-2">
							<p bind:this={blockedReason} class="text-xs text-muted-foreground" tabindex="-1" data-testid="run-blocked">{blocked}</p>
							{#if fix === 'connection'}
								<Popover.Root bind:open={connectionOpen}>
									<Popover.Trigger>
										{#snippet child({ props })}
											<Button {...props} size="xs" variant="outline" data-testid="set-up-text-connection">
												{library.connectionsProblem ? 'Text connection settings' : 'Set up the text connection'}
											</Button>
										{/snippet}
									</Popover.Trigger>
									<Popover.Content
										collisionPadding={8}
										class="max-h-(--bits-popover-content-available-height) w-80 max-w-[calc(100vw-1rem)] overflow-y-auto"
										onCloseAutoFocus={(event) => {
											// Escape or a click outside: the trigger is still here and takes focus back.
											if (fix === 'connection') return;
											event.preventDefault();
										}}
									>
										<SettingsForm only="text" />
									</Popover.Content>
								</Popover.Root>
							{:else if fix === 'recipe' && row}
								<Button
									bind:ref={goToInstructionsButton}
									size="xs"
									variant="outline"
									onclick={() => void goToInstructions()}
									data-testid="go-to-instructions"
								>
									Go to Instructions
								</Button>
							{/if}
						</div>
					{/if}

					{#if textRun}
						<div class="flex flex-col gap-2 rounded border p-3 text-sm" data-testid="text-run" data-run-state={textRun.state.kind}>
							{#if textRun.state.kind === 'running'}
								<p class="flex items-center gap-2 font-medium"><Spinner class="size-3.5" /> Running on pasted text…</p>
							{:else if textRun.state.kind === 'failed'}
								<p class="font-medium">No result was received.</p>
								<p class="text-xs text-muted-foreground" role="alert" data-testid="text-run-error">{textRun.state.message}</p>
								<div class="flex items-center gap-2">
									<Button size="sm" disabled={library.isRetrying(textRun.id)} onclick={() => void library.retryTransformation(textRun.id)} data-testid="retry-text-run">
										Try again
									</Button>
									<Button size="sm" variant="ghost" onclick={() => discard(textRun)}>Dismiss</Button>
								</div>
							{:else}
								{@const result = textRun.state.text}
								<p class="font-medium">The result arrived. It is not saved until you save it.</p>
								{#if textRun.state.message}
									<p class="text-xs text-destructive" role="alert" data-testid="text-run-save-error">{textRun.state.message}</p>
								{/if}
								<div class="grid gap-2 sm:grid-cols-2">
									<div class="flex min-w-0 flex-col gap-1">
										<span class="text-xs text-muted-foreground">Pasted text, as sent</span>
										<p class="max-h-48 overflow-y-auto rounded border bg-background p-2 text-xs whitespace-pre-wrap">{textRun.fields.input}</p>
									</div>
									<div class="flex min-w-0 flex-col gap-1">
										<span class="text-xs text-muted-foreground">Result · {textRun.fields.model} at {textRun.fields.endpoint}</span>
										<p class="max-h-48 overflow-y-auto rounded border bg-background p-2 whitespace-pre-wrap" data-testid="text-run-result">{result}</p>
									</div>
								</div>
								<p class="text-xs text-muted-foreground">
									Save keeps it as a result, with the text that was sent. Nothing is sent again.
								</p>
								<div class="flex items-center gap-2">
									<Button size="sm" disabled={library.isRetrying(textRun.id)} onclick={() => void save(textRun)} data-testid="save-text-run">
										{#if library.isRetrying(textRun.id)}<Spinner class="size-3.5" />{/if}
										Save
									</Button>
									<Button size="sm" variant="outline" onclick={() => void copyText(result, 'the result')}>Copy</Button>
									<Button size="sm" variant="ghost-destructive" onclick={() => discard(textRun)} data-testid="discard-text-run">Discard</Button>
								</div>
							{/if}
						</div>
					{/if}
				</div>

				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Results</h3>
					{#if library.textResultsError}
						<p class="text-xs text-destructive" role="alert" data-testid="text-results-error">
							Results on pasted text could not be listed, so this is the last list that was: {library.textResultsError}
						</p>
					{/if}
					{#each outputs as output (output.entry.path)}
						<TransformationOutput {library} {output} naming="source" {onOpenFile} />
					{:else}
						<p class="text-sm text-muted-foreground">No results yet.</p>
					{/each}
					{#if library.textRepairs.length > 0}
						<p class="text-xs text-warning" role="status">
							Files in <code class="font-mono">text_runs/</code> that do not read as results:
							{library.textRepairs.map((item) => item.path).join(', ')}
						</p>
					{/if}
				</div>
			</div>
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
			{#if source}
				<p class="text-xs text-muted-foreground">
					The file’s exact text. It saves as typed, readable or not.
				</p>
				<Textarea
					class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
					bind:value={() => lf(source?.draft ?? ''), (value) => source?.input(withFileNewlines(value, source.draft))}
					disabled={source.locked}
					aria-label="Markdown source"
					spellcheck={false}
					data-testid="transformation-source"
				/>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
	{/if}

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<span><code class="font-mono">{path}</code></span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(library, path)} data-testid="delete-transformation">
			Delete transformation
		</Button>
	</div>
</section>
