<!--
	One transformation: its instructions, model, results, and a place to try
	it. Title, model, instructions, and source are each a draft over the row
	the folder shows, saved as they are typed. Run sends the recipe as it is
	shown; in Source it sends the row in the folder.
-->
<script lang="ts">
	import { readRow } from '@epicenter/folder';
	import { edit, fileEdit } from '@epicenter/svelte/folder';
	import RowIssues from '@epicenter/svelte/row-issues';
	import UnsavedEdit from '@epicenter/svelte/unsaved-edit';
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import * as Collapsible from '@epicenter/ui/collapsible';
	import * as Field from '@epicenter/ui/field';
	import * as Popover from '@epicenter/ui/popover';
	import * as Select from '@epicenter/ui/select';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import * as Tabs from '@epicenter/ui/tabs';
	import { Textarea } from '@epicenter/ui/textarea';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlayIcon from '@lucide/svelte/icons/play';
	import { getFolder } from '$lib/folder.js';
	import { tick } from 'svelte';
	import { rowIdOf, TRANSFORMATIONS, whisperingTables } from '$lib/definition.js';
	import type { RecipeRow } from '$lib/recipe.js';
	import { getWhispering, type TransformationEntry } from '$lib/whispering.svelte.js';
	import { confirmDelete, formatTime, recordingTitle } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
	import SettingsForm from './SettingsForm.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	let {
		path,
		entry,
		onBack,
		onOpenFile,
	}: {
		/** The transformation's file. The parent keys this view by it. */
		path: string;
		/** The listed row, or undefined when the file left the folder. */
		entry: TransformationEntry | undefined;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
		onOpenFile: (path: string) => void;
	} = $props();
	const whispering = getWhispering();
	const folder = getFolder();
	const { view } = whispering;

	// The parent keys this view by the file; keep its original path.
	// svelte-ignore state_referenced_locally
	const own = path;
	const id = rowIdOf(TRANSFORMATIONS, own) ?? own;
	const stored = $derived(folder.tables.transformations.row(id));
	const file = $derived(folder.file(own));

	const title = edit(
		() => (stored?.issues === null ? stored.fields.title : ''),
		(title) => folder.tables.transformations.update(id, { fields: { title } }),
	);
	const modelText = edit(
		() => (stored?.issues === null ? (stored.fields.model ?? '') : ''),
		// An empty model uses the text connection's model.
		(model) =>
			folder.tables.transformations.update(id, {
				fields: { model: model.trim() === '' ? null : model },
			}),
	);
	const prompt = edit(
		() => (stored?.issues === null ? stored.body : ''),
		(body) => folder.tables.transformations.update(id, { body }),
	);
	const source = fileEdit(folder, own);

	const asText = $derived(whispering.showsText(own));
	/** The file's text, when the folder holds it as text. */
	const text = $derived(typeof file?.data === 'string' ? file.data : undefined);
	/** Why the text in Source does not read as a transformation, as it is typed. */
	const issues = $derived(
		asText && text !== undefined
			? (readRow(source.value, whisperingTables.transformations).issues ?? undefined)
			: undefined,
	);
	/** The transformation as the folder shows it, while its fields are what is edited. */
	const row = $derived(!asText && stored?.issues === null ? stored : undefined);
	/** The recipe as its fields show it, typing included; undefined in Source. */
	const shown = $derived<RecipeRow | undefined>(
		row
			? {
					fields: { title: title.value, model: modelText.value.trim() || null },
					body: prompt.value,
				}
			: undefined,
	);
	/** What Run sends: the recipe as shown, or in Source the row in the folder. */
	const recipe = $derived(shown ?? (stored?.issues === null ? stored : undefined));

	const field = (key: 'title' | 'model') => recipe?.fields[key] ?? '';
	/** The one decision about this recipe, as it is shown; Run decides again from the same recipe. */
	const resolved = $derived(whispering.resolve(recipe));
	const connection = $derived(whispering.connections?.text);
	/** Saved results on transcripts and on pasted text, newest first. */
	const outputs = $derived(
		[
			...whispering.outputsOf(id).map((item) => ({ source: 'transcript' as const, entry: item })),
			...whispering.textOutputsOf(id).map((item) => ({ source: 'text' as const, entry: item })),
		].sort((a, b) => b.entry.row.fields.createdAt.localeCompare(a.entry.row.fields.createdAt)),
	);
	/** The model a run would use: this transformation's own, or the text connection's. */
	const model = $derived(field('model').trim() || connection?.model.trim() || undefined);
	/** Whether the model and connection notes are open; a fix that needs them opens them. */
	let notesOpen = $state(false);
	let connectionOpen = $state(false);

	/**
	 * Saved transcripts with text, newest first, named by their recording. Any
	 * recording offers its transcripts, whatever its file is named and whatever
	 * else in its file needs fixing.
	 */
	const transcripts = $derived(
		whispering.entries.flatMap((recording) =>
			whispering
				.resultsFor(recording.stem)
				.filter((result) => result.row.body.trim() !== '')
				.map((result) => ({
					result,
					label: `${recordingTitle(recording)} · ${formatTime(result.row.fields.createdAt, 'short')}`,
				})),
		),
	);
	const chosen = $derived(transcripts.find((item) => item.result.path === view.applyTo));
	/** This recipe's runs under way, on a transcript and on pasted text. Each result shows below once its file is written. */
	const running = $derived(whispering.recipeRuns.some((run) => run.transformationId === id && run.transcriptionId !== undefined));
	const runningOnText = $derived(whispering.recipeRuns.some((run) => run.transformationId === id && run.transcriptionId === undefined));
	/** Authoring comes first. */
	// Workflow selection within the fields view; whether the file shows as text says whether Source shows.
	let tab = $state<'instructions' | 'try'>('instructions');
	$effect(() => {
		if (issues) tab = 'instructions';
	});
	let editor = $state<HTMLElement | null>(null);
	let tabTriggers = $state<Record<'instructions' | 'try', HTMLElement | null>>({ instructions: null, try: null });
	/** What focus can move to when the control that had it goes away. */
	let runButtons = $state<Record<'transcript' | 'pasted', HTMLElement | null>>({ transcript: null, pasted: null });
	let goToInstructionsButton = $state<HTMLElement | null>(null);
	let blockedReason = $state<HTMLElement | null>(null);
	/** Why Run is unavailable, in the order a person would fix it, or undefined when it can run. */
	const blocked = $derived.by(() => {
		if (entry === undefined) return 'This transformation is not in the folder.';
		// The request sends this recipe, so decide by what is shown.
		if (resolved.kind === 'blocked') return resolved.reason;
		if (view.applySource === 'pasted') {
			if (runningOnText) return 'Running on pasted text…';
			if (view.pastedText.trim() === '') return 'Paste some text to run this on.';
			return undefined;
		}
		if (transcripts.length === 0) return 'Transcribe a recording first, or paste text to run this on.';
		if (chosen === undefined) return 'Choose a transcript to run this on.';
		return undefined;
	});
	/** What a person fixes when Whispering's decision is what blocks Run. */
	const fix = $derived(entry !== undefined && resolved.kind === 'blocked' ? resolved.fix : undefined);

	async function run() {
		// The run sends the recipe as shown and writes its own result before sending.
		const inputs = shown ? { recipe: shown } : {};
		const problem =
			view.applySource === 'pasted'
				? await whispering.transformText(own, view.pastedText, inputs)
				: chosen && (await whispering.transform(chosen.result.path, own, inputs));
		if (problem) toast.error('The transformation did not run', { description: problem });
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
		if (!show(false)) return;
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
		(blocked === undefined ? runButtons[view.applySource] : (goToInstructionsButton ?? blockedReason))?.focus();
	}

	/** Show the fields or whole text while queued edits keep their order. */
	function show(asSource: boolean) {
		const problem = asSource ? whispering.editSource(own) : whispering.useForm(own, source.value);
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
				bind:value={title.value}
				placeholder="Title"
				aria-label="Transformation title"
				data-testid="transformation-title"
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium" data-testid="transformation-title-text">{field('title') || id}</h2>
		{/if}
	</div>
	{#if title.error}
		<div class="px-4 pt-2"><UnsavedEdit edit={title} /></div>
	{/if}

	{#if issues}
		<div class="border-b bg-destructive/5 px-4 py-2 text-xs" role="status" data-testid="needs-repair">
			<p class="mb-1 flex flex-wrap items-center gap-2 font-medium">
				<Badge variant="destructive">Needs repair</Badge>
				This file does not read as a transformation yet. Fix it in Source; it saves as you type.
			</p>
			<RowIssues {issues} />
		</div>
	{/if}

	{#if file?.readError}
		<div class="flex flex-col items-start gap-2 border-b px-4 py-2 text-sm" role="alert" data-testid="row-unopened">
			<p class="text-destructive">This file could not be read: {file.readError.message}</p>
			<Button size="sm" variant="outline" onclick={() => folder.refresh()}>Try again</Button>
		</div>
	{/if}

	{#if file === undefined}
		<p class="flex-1 px-4 py-4 text-sm text-muted-foreground" role="status">This file is no longer in the folder.</p>
	{:else if text === undefined}
		{#if file.data !== undefined}
			<p class="flex-1 px-4 py-4 text-sm text-muted-foreground" role="status" data-testid="row-unopened">This file is not UTF-8 text, so it is not opened here.</p>
		{/if}
	{:else}
	<Tabs.Root bind:value={
		() => tab === 'try' ? 'try' : asText ? 'source' : 'instructions',
		(value) => {
			if (value === 'try') {
				tab = 'try';
				return;
			}
			if (show(value === 'source')) tab = 'instructions';
		}
	} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger bind:ref={tabTriggers.instructions} value="instructions" disabled={issues !== undefined} data-testid="tab-instructions">Instructions</Tabs.Trigger>
			<Tabs.Trigger bind:ref={tabTriggers.try} value="try" data-testid="tab-try">
				Try it
				{#if running || runningOnText}
					<Spinner class="size-3" aria-label="Running" />
				{/if}
			</Tabs.Trigger>
			<Tabs.Trigger value="source">Source</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="instructions" class="min-h-0 flex-1 overflow-y-auto">
			<div class="flex flex-col gap-4 py-1">
				<Field.Field>
					<Field.Label for="transformation-prompt">Instructions</Field.Label>
					{#if row}
						<Textarea
							id="transformation-prompt"
							class="min-h-36 resize-y font-sans"
							bind:value={prompt.value}
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
								<span class={['truncate font-normal', (whispering.connectionsProblem || !connection || !model) && 'text-destructive']}>
									· {model ?? 'no model named'} ·
									{whispering.connectionsProblem ? 'the text connection could not be read' : (connection?.baseUrl ?? 'no text connection')}
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
									bind:value={modelText.value}
									placeholder={connection?.model ? `The text connection’s model: ${connection.model}` : 'The text connection’s model'}
									autocomplete="off"
									spellcheck={false}
									data-testid="transformation-model"
								/>
							{:else}
								<p class="text-sm" data-testid="transformation-model-text">{field('model') || 'The text connection’s model'}</p>
							{/if}
							<Field.Description>
								Leave empty to use the text connection’s model. Typed exactly as the endpoint names it; Whispering keeps no list of models.
							</Field.Description>
						</Field.Field>
						<div class="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="transform-note">
							{#if connection}
								<p>Sends to the text connection: {connection.baseUrl}.</p>
							{:else if whispering.connectionsProblem}
								<p class="text-destructive">The text connection could not be read: {whispering.connectionsProblem}</p>
							{:else}
								<p>No text connection is set up. Set one up in Settings to run this.</p>
							{/if}
							<p>{whispering.services.transformNote}</p>
							<p>
								A result on a transcript is saved as a new file in <code class="font-mono">transformation_runs/</code>, and a result on
								pasted text in <code class="font-mono">text_runs/</code>. Each file is written when the run starts and gets its answer
								when it arrives. The text it came from is never changed.
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
						value={view.applySource}
						onValueChange={(next) => (view.applySource = next === 'pasted' ? 'pasted' : 'transcript')}
						class="flex flex-col gap-2"
					>
						<Tabs.List class="self-start" aria-label="Run it on">
							<Tabs.Trigger value="transcript" data-testid="apply-transcript">A transcript</Tabs.Trigger>
							<Tabs.Trigger value="pasted" data-testid="apply-pasted">Pasted text</Tabs.Trigger>
						</Tabs.List>
						<Tabs.Content value="transcript" class="flex flex-col gap-2">
							<div class="flex flex-wrap items-center gap-2">
								<Select.Root type="single" bind:value={() => view.applyTo ?? '', (value) => (view.applyTo = value || undefined)}>
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
									Run sends the instructions and this transcript. The answer is saved as a new result below; the
									transcript does not change.
								</p>
							{/if}
						</Tabs.Content>
						<Tabs.Content value="pasted" class="flex flex-col gap-2">
							<Textarea
								class="min-h-28 resize-y font-sans"
								bind:value={view.pastedText}
								placeholder="Paste text to try this on. It stays here while you move between pages and transformations. Running saves it with its result."
								aria-label="Text to transform"
								data-testid="pasted-text"
							/>
							<div class="flex flex-wrap items-center gap-2">
								<Button bind:ref={runButtons.pasted} disabled={blocked !== undefined} onclick={() => void run()} data-testid="run-pasted">
									{#if runningOnText}<Spinner class="size-3.5" />{:else}<PlayIcon />{/if}
									Run on pasted text
								</Button>
								{#if !blocked}
									<span class="text-xs text-muted-foreground">
										Run sends the instructions and this text. The answer is saved as a new result below.
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
												{whispering.connectionsProblem ? 'Text connection settings' : 'Set up the text connection'}
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

				</div>

				<div class="flex flex-col gap-2">
					<h3 class="text-sm font-medium">Results</h3>
					{#each outputs as output (output.entry.path)}
						<TransformationOutput {output} naming="source" {onOpenFile} />
					{:else}
						<p class="text-sm text-muted-foreground">No results yet.</p>
					{/each}
					{#if whispering.textRepairs.length > 0}
						<p class="text-xs text-warning" role="status">
							Files in <code class="font-mono">text_runs/</code> that do not read as results:
							{whispering.textRepairs.map((item) => item.path).join(', ')}
						</p>
					{/if}
				</div>
			</div>
		</Tabs.Content>
		<Tabs.Content value="source" class="flex min-h-0 flex-1 flex-col gap-2">
			<p class="text-xs text-muted-foreground">
				The file’s exact text. It saves as you type, readable or not.
			</p>
			<Textarea
				class="h-full min-h-40 flex-1 resize-none font-mono text-xs"
				bind:value={source.value}
				{@attach () => { whispering.editSource(own); }}
				aria-label="Markdown source"
				spellcheck={false}
				data-testid="transformation-source"
			/>
		</Tabs.Content>
	</Tabs.Root>
	{/if}
	<UnsavedEdit edit={prompt} />
	<UnsavedEdit edit={modelText} />
	<UnsavedEdit edit={source} />

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<span><code class="font-mono">{path}</code></span>
		<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => void confirmDelete(whispering, path)} data-testid="delete-transformation">
			Delete transformation
		</Button>
	</div>
</section>
