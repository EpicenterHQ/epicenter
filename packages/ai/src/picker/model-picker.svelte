<!--
	Pick a model from every endpoint the app merged (`openAi`, read through
	`reactive`), grouped by
	endpoint in the merged order, and keep the person's own connections: add
	one with its key, edit it, refresh its models, or remove it. The owner
	saves each complete choice (`onSelect`). Opening the picker asks probing
	endpoints, such as Ollama and LM Studio, to look again.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import * as Command from '@epicenter/ui/command';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Popover from '@epicenter/ui/popover';
	import { Spinner } from '@epicenter/ui/spinner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Check from '@lucide/svelte/icons/check';
	import ChevronsUpDown from '@lucide/svelte/icons/chevrons-up-down';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { createMutation, QueryClient } from '@tanstack/svelte-query';
	import { onDestroy } from 'svelte';
	import { unwrap } from 'wellcrafted/result';
	import { type AiError, createClient } from '../client.js';
	import { custom } from '../custom.js';
	import type { Capability, Endpoint } from '../endpoint.js';
	import type { Ai, ModelChoice } from '../open-ai.js';
	import { CONNECTION_PRESETS, type PresetId } from './presets.js';

	let {
		ai,
		can = 'chat',
		value,
		onSelect,
		disabled = false,
		placeholder = 'Select model',
	}: {
		/** The app's `openAi`, as `reactive` adapts it. */
		ai: Ai;
		/** What a listed model must be able to do. */
		can?: Capability;
		value: ModelChoice | null;
		onSelect: (choice: ModelChoice) => void;
		/** Disable while a turn generates, so a transcript never spans backends. */
		disabled?: boolean;
		placeholder?: string;
	} = $props();

	let open = $state(false);
	let formVersion = 0;
	let alive = true;
	let view = $state<'list' | 'connect'>('list');

	// The person's connections, merged in `ai` (`customEndpoints()`); reading
	// them through `ai` reruns this when one is added, edited or removed.
	const connections = $derived(ai.custom());
	const records = $derived(connections?.list() ?? []);
	/** Why the saved connections do not read, naming the file; a connection added replaces it. */
	const problem = $derived(connections?.problem() ?? null);
	/** The endpoint a saved connection makes, which on the desktop sends with the key the shell keeps. */
	const endpointOf = (id: string) =>
		connections?.endpoints().find((endpoint) => endpoint.id === id);
	const groups = $derived(
		ai.endpoints().map((endpoint) => ({
			endpoint,
			record: records.find((record) => record.id === endpoint.id),
			models: ai.models().filter(
				(model) => model.endpoint === endpoint.id && model.can.includes(can),
			),
		})),
	);

	// "Connect a provider" form state. `formPreset` null means the preset chooser
	// is showing; a value means its sub-form is.
	let formPreset = $state<PresetId | 'custom' | null>(null);
	let formBaseUrl = $state('');
	let formName = $state('');
	let editingId = $state<string | null>(null);
	let formApiKey = $state('');
	let removeApiKey = $state(false);
	const savedConnection = $derived(
		editingId ? records.find((entry) => entry.id === editingId) : undefined,
	);
	let formModel = $state('');
	let showKey = $state(false);

	// Discovery state for the connect form.
	let discovering = $state(false);
	let discovered = $state.raw<string[] | null>(null);
	let discoveryError = $state<string | null>(null);

	// The picker also runs in apps without a QueryClientProvider.
	const queryClient = new QueryClient();
	onDestroy(() => {
		alive = false;
		queryClient.clear();
	});
	const refreshConnection = createMutation(
		() => ({
			mutationFn: async (id: string) => {
				const record = connections?.list().find((entry) => entry.id === id);
				const endpoint = endpointOf(id);
				if (!connections || !record || !endpoint) return;
				const found = unwrap(await createClient(endpoint).listModels());
				await connections.update(id, {
					models: [...new Set([...record.models, ...found])],
				});
			},
		}),
		() => queryClient,
	);
	const removeConnection = createMutation(
		() => ({
			mutationFn: (id: string) => connections!.remove(id),
		}),
		() => queryClient,
	);

	// Clear the connect form's working state, so a reopened picker lands on the
	// preset chooser rather than a stale sub-form with a leftover typed key.
	function resetConnectForm() {
		formVersion++;
		formPreset = null;
		formBaseUrl = '';
		formName = '';
		editingId = null;
		formApiKey = '';
		removeApiKey = false;
		formModel = '';
		showKey = false;
		discovering = false;
		discovered = null;
		discoveryError = null;
	}

	// Turn a discovery failure into a hint: fix the URL, the key, or type a model.
	function discoveryMessage(error: AiError): string {
		switch (error.name) {
			case 'Unreachable':
				return "Couldn't reach this endpoint. Check the URL and that the server is running, or type a model manually.";
			case 'Refused':
				if (error.status === 401 || error.status === 403)
					return 'The endpoint rejected this API key. Check the key, then type a model manually.';
				return `The endpoint returned ${error.status}. Type a model manually.`;
			case 'Malformed':
				return "This endpoint didn't return an OpenAI model list. Type a model manually.";
			default:
				return 'Could not discover models. Type a model manually.';
		}
	}

	function hostLabel(baseUrl: string): string {
		try {
			const url = new URL(baseUrl);
			return `${url.host}${url.pathname.replace(/\/+$/, '')}`;
		} catch {
			return 'Invalid endpoint';
		}
	}

	function headingOf(endpoint: Endpoint) {
		return endpoint.source === 'local'
			? `${endpoint.name} on this computer`
			: endpoint.name;
	}

	const triggerLabel = $derived.by(() => {
		if (!value) return placeholder;
		const chosen = value;
		const model = ai.models().find(
			(entry) => entry.endpoint === chosen.endpoint && entry.id === chosen.model,
		);
		const endpoint = ai.endpoints().find((entry) => entry.id === chosen.endpoint);
		return `${model?.label ?? chosen.model} · ${endpoint?.name ?? 'Unavailable'}`;
	});

	function isSelected(endpoint: string, id: string) {
		return value?.endpoint === endpoint && value.model === id;
	}

	function selectModel(endpoint: string, id: string) {
		onSelect({ endpoint, model: id });
		open = false;
	}

	function choosePreset(id: PresetId | 'custom') {
		formVersion++;
		formPreset = id;
		formApiKey = '';
		removeApiKey = false;
		formModel = '';
		discovered = null;
		discoveryError = null;
		formBaseUrl =
			id === 'custom'
				? ''
				: (CONNECTION_PRESETS.find((preset) => preset.id === id)?.baseUrl ?? '');
	}

	// Save the connection before the choice. A failed save keeps the form open.
	const saveConnection = createMutation(
		() => ({
			mutationFn: async (chosenModel: string) => {
				const attempt = { connections, formVersion };
				const baseUrl = formBaseUrl.trim();
				const trimmedModel = chosenModel.trim();
				if (!attempt.connections) throw new Error('Saved connections are unavailable.');
				if (!baseUrl || !trimmedModel) throw new Error('Enter an endpoint and model.');
				const credential = removeApiKey
					? { apiKey: '' }
					: formApiKey.trim()
						? { apiKey: formApiKey.trim() }
						: {};
				const input = {
					baseUrl,
					name: formName.trim() || savedConnection?.name || undefined,
					...credential,
					models: [
						...new Set([
							...(savedConnection?.models ?? []),
							...(discovered ?? []),
							trimmedModel,
						]),
					],
				};
				const id = editingId;
				if (id) {
					await attempt.connections.update(id, input);
					return { ...attempt, id, model: trimmedModel };
				}
				return {
					...attempt,
					id: await attempt.connections.add(input),
					model: trimmedModel,
				};
			},
			onSuccess: (saved) => {
				if (
					!alive ||
					!open ||
					saved.connections !== connections ||
					saved.formVersion !== formVersion
				)
					return;
				editingId = saved.id;
				selectModel(saved.id, saved.model);
			},
		}),
		() => queryClient,
	);

	// Reopening the picker lands on the model list, and looks for local servers again.
	$effect(() => {
		if (!open) {
			view = 'list';
			resetConnectForm();
			return;
		}
		void ai.refresh();
	});

	// Discover models on a debounced change of the connect form's endpoint or key.
	// Best effort: a failure degrades to typing a model, never a toast.
	$effect(() => {
		if (view !== 'connect') return;
		if (editingId && !savedConnection) {
			discovered = null;
			discovering = false;
			discoveryError = 'This connection is no longer available.';
			return;
		}
		const url = formBaseUrl.trim();
		const key = formApiKey.trim();
		const retainSavedKey = savedConnection?.hasApiKey && !key && !removeApiKey;
		const saved =
			savedConnection && savedConnection.baseUrl === url && !key && !removeApiKey
				? savedConnection
				: undefined;
		if (retainSavedKey && !saved) {
			discovered = null;
			discovering = false;
			discoveryError =
				'Save the changed endpoint with a model ID before discovering models with its saved key.';
			return;
		}
		if (!url) {
			discovered = null;
			discoveryError = null;
			discovering = false;
			return;
		}
		discovered = null;
		discovering = true;
		discoveryError = null;
		const controller = new AbortController();
		const handle = setTimeout(async () => {
			// A saved connection discovers through its own endpoint, which on the
			// desktop holds the key in the shell; a new one through the typed key.
			const endpoint =
				(saved && endpointOf(saved.id)) || custom({ baseUrl: url, key });
			const { data, error } = await createClient(endpoint).listModels({
				signal: controller.signal,
			});
			if (controller.signal.aborted) return;
			discovering = false;
			if (error) {
				discovered = null;
				discoveryError = discoveryMessage(error);
				return;
			}
			discovered = data;
		}, 500);
		return () => {
			controller.abort();
			clearTimeout(handle);
		};
	});
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				{disabled}
				variant="outline"
				size="sm"
				role="combobox"
				aria-label={triggerLabel}
				aria-expanded={open}
				class="max-w-56 justify-between gap-2 font-normal"
			>
				<span class="truncate">{triggerLabel}</span>
				<ChevronsUpDown class="size-4 shrink-0 opacity-50" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end">
		{#if problem}
			<p role="alert" class="p-3 text-xs text-destructive">{problem.message}</p>
		{/if}
		{#if view === 'list'}
			<Command.Root>
				<Command.Input placeholder="Search models..." />
				<Command.List class="max-h-80">
					<Command.Empty>No models found.</Command.Empty>
					{#each groups as group (group.endpoint.id)}
						{@const { endpoint, record, models } = group}
						{#if models.length > 0 || record}
							<Command.Group heading={headingOf(endpoint)}>
								{#each models as model (model.id)}
									<Command.Item
										value="{endpoint.id} {model.id}"
										keywords={[model.id, model.label ?? '', endpoint.name]}
										onSelect={() => selectModel(endpoint.id, model.id)}
									>
										<Check
											class="size-4 shrink-0 {isSelected(endpoint.id, model.id)
												? 'opacity-100'
												: 'opacity-0'}"
										/>
										<span
											class="line-clamp-2 flex-1 break-all {isSelected(endpoint.id, model.id)
												? 'font-medium'
												: ''}"
											title={model.id}>{model.label ?? model.id}</span>
									</Command.Item>
								{:else}
									<Command.Item disabled value="{endpoint.id} empty">
										<span class="text-xs text-muted-foreground">No models discovered</span>
									</Command.Item>
								{/each}
								{#if record}
									<Command.Item
										value="configure {endpoint.id}"
										onSelect={() => {
											choosePreset('custom');
											formBaseUrl = record.baseUrl;
											formName = record.name;
											editingId = record.id;
											saveConnection.reset();
											view = 'connect';
										}}
									>
										<Plus class="size-4" />
										<span class="text-xs">Edit {endpoint.name} or enter a model</span>
									</Command.Item>
									<Command.Item
										value="refresh {endpoint.id}"
										disabled={refreshConnection.isPending && refreshConnection.variables === endpoint.id}
										onSelect={() => refreshConnection.mutate(endpoint.id)}
									>
										{#if refreshConnection.isPending && refreshConnection.variables === endpoint.id}
											<Spinner class="size-4" />
										{:else}
											<RefreshCw class="size-4" />
										{/if}
										<span class="text-xs">Refresh {endpoint.name}</span>
									</Command.Item>
									<Command.Item
										value="remove {endpoint.id}"
										disabled={removeConnection.isPending}
										onSelect={() => removeConnection.mutate(endpoint.id)}
									>
										<Trash2 class="size-4" />
										<span class="text-xs">Remove {endpoint.name}</span>
									</Command.Item>
								{/if}
							</Command.Group>
						{/if}
					{/each}

					<Command.Separator />
					<Command.Item
						value="connect a provider"
						disabled={!connections}
						onSelect={() => (view = 'connect')}
					>
						<Plus class="size-4" />
						<span>Connect a provider...</span>
					</Command.Item>
				</Command.List>
			</Command.Root>
		{:else}
			<fieldset class="space-y-3 p-3" disabled={saveConnection.isPending}>
				<div class="flex items-center gap-2">
					<IconButton
						label="Back to models"
						size="sm"
						variant="ghost"
						disabled={saveConnection.isPending}
						onclick={() => (view = 'list')}
					>
						<ArrowLeft class="size-4" />
					</IconButton>
					<p class="text-sm font-medium">Connect a provider</p>
				</div>

				{#if formPreset === null}
					<Command.Root class="rounded-md border">
						<Command.List>
							{#each CONNECTION_PRESETS as preset (preset.id)}
								<Command.Item value={preset.label} onSelect={() => choosePreset(preset.id)}>
									<span class="flex-1">{preset.label}</span>
									<span class="text-xs text-muted-foreground">{hostLabel(preset.baseUrl)}</span>
								</Command.Item>
							{/each}
							<Command.Separator />
							<Command.Item value="custom url" onSelect={() => choosePreset('custom')}>
								<Plus class="size-4 shrink-0 opacity-70" />
								<span class="flex-1">Custom URL</span>
							</Command.Item>
						</Command.List>
					</Command.Root>
					<p class="text-xs text-muted-foreground">
						Ollama and LM Studio on this computer appear on their own while they run.
					</p>
				{:else}
					<div class="space-y-1">
						<Label for="conn-name" class="text-xs">Name</Label>
						<Input id="conn-name" bind:value={formName} placeholder="Connection name" />
						<Label for="conn-url" class="text-xs">Base URL</Label>
						<Input
							id="conn-url"
							bind:value={formBaseUrl}
							disabled={saveConnection.isPending}
							placeholder="https://api.example.com/v1"
						/>
					</div>

					<div class="space-y-1">
						<Label for="conn-key" class="text-xs">API key (if required by your server)</Label>
						<div class="flex gap-1">
							<Input
								id="conn-key"
								type={showKey ? 'text' : 'password'}
								bind:value={formApiKey}
								disabled={saveConnection.isPending || removeApiKey}
								placeholder={savedConnection?.hasApiKey ? 'Leave blank to keep saved key' : 'sk-...'}
							/>
							<IconButton
								label="Show key"
								size="sm"
								aria-pressed={showKey}
								variant="ghost"
								onclick={() => (showKey = !showKey)}
							>
								{#if showKey}
									<EyeOff class="size-4" />
								{:else}
									<Eye class="size-4" />
								{/if}
							</IconButton>
						</div>
					</div>

					{#if savedConnection?.hasApiKey}
						<Button variant="outline" size="sm" disabled={saveConnection.isPending} onclick={() => (removeApiKey = !removeApiKey)}>
							{removeApiKey ? 'Keep saved API key' : 'Remove saved API key'}
						</Button>
						{#if removeApiKey}<p class="text-xs text-muted-foreground">The saved key will be removed when you save.</p>{/if}
					{/if}

					<div class="space-y-1">
						<Label class="text-xs">Model</Label>
						{#if discovering}
							<p class="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner class="size-3.5" /> Loading models...
							</p>
						{:else if discovered && discovered.length > 0}
							<p class="text-xs text-muted-foreground">Pick a model to start using it.</p>
							<Command.Root class="rounded-md border">
								<Command.Input placeholder="Search models..." />
								<Command.List class="max-h-48">
									<Command.Empty>No models found.</Command.Empty>
									{#each discovered as id (id)}
										<Command.Item
											value={id}
											keywords={[id]}
											disabled={saveConnection.isPending}
											onSelect={() => saveConnection.mutate(id)}
										>
											<span class="line-clamp-2 break-all" title={id}>{id}</span>
										</Command.Item>
									{/each}
								</Command.List>
							</Command.Root>
						{:else if discoveryError}
							<p class="text-xs text-muted-foreground">{discoveryError}</p>
						{:else if formBaseUrl.trim()}
							<p class="text-xs text-muted-foreground">No models found at this endpoint, type one manually.</p>
						{:else}
							<p class="text-xs text-muted-foreground">Enter an endpoint to load models.</p>
						{/if}
						<div class="flex gap-1">
							<Input bind:value={formModel} aria-label="Model ID" placeholder="Enter a model ID" />
							<Button
								size="sm"
								disabled={saveConnection.isPending || !formBaseUrl.trim() || !formModel.trim()}
								onclick={() => saveConnection.mutate(formModel)}
							>
								{saveConnection.isPending ? 'Saving...' : editingId ? 'Save' : 'Add'}
							</Button>
						</div>
					</div>

					<p class="text-xs text-muted-foreground">
						Requests go straight to this URL. Your Epicenter sign-in is never sent there.
					</p>
				{/if}
			</fieldset>
		{/if}
		{#if saveConnection.isError || removeConnection.isError || refreshConnection.isError}
			<p role="alert" class="p-3 text-xs text-destructive">
				{saveConnection.isError ? 'Could not save the connection. Your selection has not changed.' : removeConnection.isError ? 'Could not remove the connection.' : 'Could not refresh the models.'} Try again.
			</p>
		{/if}
	</Popover.Content>
</Popover.Root>
