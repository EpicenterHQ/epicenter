<!--
	One transformation: its instructions, model, results, and a place to try
	it. Title, model and instructions are each an edit over the note the
	lists show, saved as they are typed. Run sends the recipe as it is shown.
	A transformation whose note does not read shows its text, to repair.
-->
<script lang="ts">
	import { fieldEdit } from '@epicenter/svelte/client';
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
	import { tick } from 'svelte';
	import type { RecipeRow } from '$lib/recipe.js';
	import { getWhispering, type TransformationNote } from '$lib/whispering.svelte.js';
	import { confirmDelete, formatTime, titleOf } from './file-actions.js';
	import { Input } from '@epicenter/ui/input';
	import NoteRepair from './NoteRepair.svelte';
	import RunStatus from './RunStatus.svelte';
	import SettingsForm from './SettingsForm.svelte';
	import TransformationOutput from './TransformationOutput.svelte';

	let {
		id,
		note,
		onBack,
	}: {
		/** The transformation's id. The parent keys this view by it. */
		id: string;
		/** The listed note, or undefined when it does not read or is gone. */
		note: TransformationNote | undefined;
		/** Shown on narrow windows, where the list and the editor take turns. */
		onBack?: () => void;
	} = $props();
	const whispering = getWhispering();
	const { view } = whispering;

	// The parent keys this view by the transformation.
	// svelte-ignore state_referenced_locally
	const own = id;
	const title = fieldEdit(whispering.files.transformations, { id: own }, 'title');
	const modelEdit = fieldEdit(whispering.files.transformations, { id: own }, 'model');
	const prompt = fieldEdit(whispering.files.transformations, { id: own }, 'body');
	/** Why its note does not read, when it does not. */
	const repair = $derived(whispering.transformationRepairs.find((item) => item.id === own));

	/** Each field as typed until its save answers, else as the note holds it. */
	const titleText = $derived(title.value ?? note?.title ?? '');
	const modelText = $derived((modelEdit.value === undefined ? note?.model : modelEdit.value) ?? '');
	const promptText = $derived(prompt.value ?? note?.body ?? '');
	/** The recipe as its fields show it, typing included. */
	const shown = $derived<RecipeRow | undefined>(
		note ? { title: titleText, model: modelText.trim() || null, body: promptText } : undefined,
	);
	/** The one decision about this recipe, as it is shown; Run decides again from the same recipe. */
	const resolved = $derived(whispering.resolve(shown));
	const connection = $derived(whispering.connections?.text);
	/** Saved results on transcripts and on pasted text, newest first. */
	const outputs = $derived(
		[
			...whispering.outputsOf(own).map((item) => ({ source: 'transcript' as const, note: item })),
			...whispering.textOutputsOf(own).map((item) => ({ source: 'text' as const, note: item })),
		].sort((a, b) => b.note.createdAt.localeCompare(a.note.createdAt)),
	);
	/** The model a run would use: this transformation's own, or the text connection's. */
	const model = $derived(modelText.trim() || connection?.model.trim() || undefined);
	/** Whether the model and connection notes are open; a fix that needs them opens them. */
	let notesOpen = $state(false);
	let connectionOpen = $state(false);

	/**
	 * Saved transcripts with text, newest first, named by their recording.
	 */
	const transcripts = $derived(
		whispering.entries.flatMap((recording) =>
			whispering
				.resultsFor(recording.id)
				.filter((result) => result.body.trim() !== '')
				.map((result) => ({
					result,
					label: `${titleOf(recording)} · ${formatTime(result.createdAt, 'short')}`,
				})),
		),
	);
	const chosen = $derived(transcripts.find((item) => item.result.id === view.applyTo));
	/** This recipe's runs under way, on a transcript and on pasted text. Each result shows below once kept. */
	const running = $derived(whispering.recipeRuns.some((run) => run.collection === 'transformation_runs' && run.fields.transformationId === own));
	const runningOnText = $derived(whispering.recipeRuns.some((run) => run.collection === 'text_runs' && run.fields.transformationId === own));
	/** What became of this recipe's last runs here: on the chosen transcript, and on pasted text. */
	const settled = $derived(
		[
			...(chosen ? whispering.runsOn(chosen.result.id) : []).filter(
				(run) => run.collection === 'transformation_runs' && run.fields.transformationId === own,
			),
			...[whispering.textRun(own)].filter((run) => run !== undefined),
		].filter((run) => run.state.kind !== 'running'),
	);
	/** Authoring comes first. */
	let tab = $state<'instructions' | 'try'>('instructions');
	let editor = $state<HTMLElement | null>(null);
	let tabTriggers = $state<Record<'instructions' | 'try', HTMLElement | null>>({ instructions: null, try: null });
	/** What focus can move to when the control that had it goes away. */
	let runButtons = $state<Record<'transcript' | 'pasted', HTMLElement | null>>({ transcript: null, pasted: null });
	let goToInstructionsButton = $state<HTMLElement | null>(null);
	let blockedReason = $state<HTMLElement | null>(null);
	/** Why Run is unavailable, in the order a person would fix it, or undefined when it can run. */
	const blocked = $derived.by(() => {
		if (note === undefined) return 'This transformation is not listed.';
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
	const fix = $derived(note !== undefined && resolved.kind === 'blocked' ? resolved.fix : undefined);

	async function run() {
		// The run sends the recipe as shown; its result is kept when the answer arrives.
		const inputs = shown ? { recipe: shown } : {};
		const problem =
			view.applySource === 'pasted'
				? await whispering.transformText(own, view.pastedText, inputs)
				: chosen && (await whispering.transform(chosen.result.id, own, inputs));
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
	function goToInstructions() {
		const from = document.activeElement;
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

	function selectTab(value: string) {
		tab = value === 'try' ? 'try' : 'instructions';
	}
</script>

<section bind:this={editor} class="flex h-full min-h-0 flex-col" aria-label="Transformation" data-testid="transformation-detail">
	<div class="flex items-center gap-2 border-b px-3 py-3 sm:px-4">
		{#if onBack}
			<Button variant="ghost" size="icon-sm" aria-label="Back to transformations" onclick={onBack} {@attach (node: HTMLElement) => node.focus()}>
				<ArrowLeftIcon />
			</Button>
		{/if}
		{#if note}
			<Input
				class="flex-1 text-base font-medium"
				bind:value={() => titleText, (value) => (title.value = value)}
				placeholder="Title"
				aria-label="Transformation title"
				data-testid="transformation-title"
			/>
		{:else}
			<h2 class="min-w-0 flex-1 truncate text-base font-medium" data-testid="transformation-title-text">{own}</h2>
		{/if}
		{#if note && whispering.notUploaded('transformations', note.id)}<Badge variant="outline">Not uploaded yet</Badge>{/if}
	</div>
	{#if title.error}
		<div class="px-4 pt-2"><UnsavedEdit edit={title} /></div>
	{/if}

	{#if repair}
		<div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
			<NoteRepair {repair} />
		</div>
	{:else if note === undefined}
		<p class="flex-1 px-4 py-4 text-sm text-muted-foreground" role="status">This transformation is no longer listed.</p>
	{:else}
	<Tabs.Root bind:value={() => tab, selectTab} class="flex min-h-0 flex-1 flex-col px-3 py-3 sm:px-4">
		<Tabs.List>
			<Tabs.Trigger bind:ref={tabTriggers.instructions} value="instructions" data-testid="tab-instructions">Instructions</Tabs.Trigger>
			<Tabs.Trigger bind:ref={tabTriggers.try} value="try" data-testid="tab-try">
				Try it
				{#if running || runningOnText}
					<Spinner class="size-3" aria-label="Running" />
				{/if}
			</Tabs.Trigger>
		</Tabs.List>
		<Tabs.Content value="instructions" class="min-h-0 flex-1 overflow-y-auto">
			<div class="flex flex-col gap-4 py-1">
				<Field.Field>
					<Field.Label for="transformation-prompt">Instructions</Field.Label>
					{#if note}
						<Textarea
							id="transformation-prompt"
							class="min-h-36 resize-y font-sans"
							bind:value={() => promptText, (value) => (prompt.value = value)}
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
							{#if note}
								<Input
									id="transformation-model"
									bind:value={() => modelText, (value) => (modelEdit.value = value.trim() === '' ? null : value)}
									placeholder={connection?.model ? `The text connection’s model: ${connection.model}` : 'The text connection’s model'}
									autocomplete="off"
									spellcheck={false}
									data-testid="transformation-model"
								/>
							{:else}
								<p class="text-sm" data-testid="transformation-model-text">{modelText || 'The text connection’s model'}</p>
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
								A result on a transcript is saved as a new note in <code class="font-mono">transformation_runs/</code>, and a result on
								pasted text in <code class="font-mono">text_runs/</code>, when its answer arrives. The text it came from is never changed.
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
											{#each transcripts as item (item.result.id)}
												<Select.Item value={item.result.id} label={item.label} />
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
								<p class="max-h-24 overflow-y-auto rounded border p-2 text-xs whitespace-pre-wrap text-muted-foreground">{chosen.result.body.trim()}</p>
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
							{:else if fix === 'recipe'}
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
					{#each settled as run (run.key)}
						<RunStatus {run} />
					{/each}
					{#each outputs as output (output.note.id)}
						<TransformationOutput {output} naming="source" />
					{:else}
						<p class="text-sm text-muted-foreground">No results yet.</p>
					{/each}
				</div>
			</div>
		</Tabs.Content>
	</Tabs.Root>
	{/if}
	<UnsavedEdit edit={prompt} />
	<UnsavedEdit edit={modelEdit} />

	<div class="flex flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
		<span><code class="font-mono">transformations/{own}.md</code></span>
		{#if note !== undefined}
			<Button class="ml-auto" size="sm" variant="ghost-destructive" onclick={() => confirmDelete(whispering, { collection: 'transformations', id: own })} data-testid="delete-transformation">
				Delete transformation
			</Button>
		{/if}
	</div>
</section>
