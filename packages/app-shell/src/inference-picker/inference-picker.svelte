<script lang="ts">
	/** Models grouped by their exact connection. A pick saves both before updating
	 * the synced model; identical model ids never imply identical destinations. */
	import {
		CONNECTION_PRESETS,
		type ListModelsError,
		type PresetId,
	} from '@epicenter/client';
	import { Button } from '@epicenter/ui/button';
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
	import { SvelteSet } from 'svelte/reactivity';
	import type { Snippet } from 'svelte';
		import type { InferenceConnections } from './connections.svelte.js';

	type Props = {
		/** Device-local selection scope, normally the conversation id. */
		scope: string;
		/** The conversation's current model id (synced, ADR-0055). */
		model: string;
		/** Commit a model pick. Writes the synced conversation model column. */
		onSelectModel: (model: string) => void;
		/** The device's inference connection registry (hosted catalog + custom set). */
		connections: InferenceConnections;
		/** Disable while a turn generates, so a transcript never spans backends. */
		disabled?: boolean;
		/** Suggestions appropriate to this workflow's account operation. */
		accountModels?: InferenceConnections['hostedModels'];
		/** Native file inference is useful to audio workflows only. */
		includeRuntime?: boolean;
		placeholder?: string;
		additionalOptions?: Snippet<[close: () => void]>;
	};

	let { scope, model, onSelectModel, connections, disabled = false, accountModels, includeRuntime = false, placeholder = 'Select model', additionalOptions }: Props = $props();
	const models = $derived(accountModels ?? connections.hostedModels);

	let open = $state(false);
	let view = $state<'list' | 'connect'>('list');

	// "Connect a provider" form state. `formPreset` null means the preset chooser
	// is showing; a value means its sub-form is.
	let formPreset = $state<PresetId | 'custom' | null>(null);
	let formBaseUrl = $state('');
 let formName = $state('');
 let editingId = $state<string | null>(null);
	let formApiKey = $state('');
	let formModel = $state('');
	let showKey = $state(false);

	// Discovery state for the connect form.
	let discovering = $state(false);
	let discovered = $state.raw<string[] | null>(null);
	// A tailored, per-variant message when discovery fails (401 vs unreachable vs
	// malformed), or null when discovery has not failed.
	let discoveryError = $state<string | null>(null);

	// Connections currently re-discovering their models, for per-group refresh
	// spinners. Usually one entry, but keep the set keyed per URL so overlapping
	// refreshes cannot clear each other's loading state.
	const refreshingBaseUrls = new SvelteSet<string>();

	// Clear all of the connect form's working state. Called on close so a user who
	// connected one provider lands back on the preset chooser (not a stale sub-form
	// with a leftover typed API key) the next time they open the picker.
	function resetConnectForm() {
		formPreset = null;
		formBaseUrl = '';
  formName = '';
  editingId = null;
		formApiKey = '';
		formModel = '';
		showKey = false;
		discovering = false;
		discovered = null;
		discoveryError = null;
	}

	// Turn a discovery failure into an actionable hint per variant, so the user
	// knows whether to fix the URL, the key, or just type a model.
	function discoveryMessage(error: ListModelsError): string {
		switch (error.name) {
			case 'Unreachable':
				return "Couldn't reach this endpoint. Check the URL and that the server is running, or type a model manually.";
			case 'RequestFailed':
				if (error.status === 401 || error.status === 403)
					return 'The endpoint rejected this API key. Check the key, then type a model manually.';
				return `The endpoint returned ${error.status}. Type a model manually.`;
			case 'Malformed':
				return "This endpoint didn't return an OpenAI model list. Type a model manually.";
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


	const selected = $derived(connections.target(scope, model));
	const triggerLabel = $derived(
		!selected
			? placeholder
			: selected.connectionId === connections.runtimeId
				? `${model} · This device`
			: selected.connectionId === connections.accountId
				? `${models.find((entry) => entry.id === model)?.label ?? model} · ${connections.accountLabel}`
				: `${model} · ${connections.custom.find(entry => entry.id === selected.connectionId)?.name ?? "Unavailable connection"}`,
	);

	function isSelected(connectionId: string, id: string) {
		return selected?.connectionId === connectionId && selected.model === id;
	}

	function selectModel(connectionId: string, id: string) {
		connections.select(scope, { connectionId, model: id });
		onSelectModel(id);
		open = false;
	}

	// Re-discover a connected endpoint's models in place. Best effort: the group's
	// list updates reactively when the fresh ids land, and stands on error.
	async function refreshConnection(baseUrl: string) {
		if (refreshingBaseUrls.has(baseUrl)) return;
		refreshingBaseUrls.add(baseUrl);
		try {
			await connections.refresh(baseUrl);
		} finally {
			refreshingBaseUrls.delete(baseUrl);
		}
	}

	function choosePreset(id: PresetId | 'custom') {
		formPreset = id;
		formApiKey = '';
		formModel = '';
		discovered = null;
		discoveryError = null;
		formBaseUrl =
			id === 'custom'
				? ''
				: (CONNECTION_PRESETS.find((p) => p.id === id)?.baseUrl ?? '');
	}

	// Save the connection being configured (caching its discovered models), select
	// the chosen model, and close: one commit for the whole "connect and use" path.
	function commitConnection(chosenModel: string) {
		const baseUrl = formBaseUrl.trim();
		const trimmedModel = chosenModel.trim();
		if (!baseUrl || !trimmedModel) return;
		const id = editingId ?? connections.add(
			{
				baseUrl,
    name: formName.trim() || undefined,
				apiKey: formApiKey.trim() || undefined,
			},
			[...new Set([...(discovered ?? []), trimmedModel])],
		);
		if (editingId) connections.update(editingId, { name: formName.trim() || connections.custom.find(entry => entry.id === editingId)?.name || 'Connection', baseUrl, apiKey: formApiKey.trim() || undefined, models: [...new Set([...(connections.custom.find(entry => entry.id === editingId)?.models ?? []), ...(discovered ?? []), trimmedModel])] });
  selectModel(id, trimmedModel);
	}

	// Reopening the picker always lands on the model list, never a half-filled form.
	$effect(() => {
		if (!open) {
			view = 'list';
			resetConnectForm();
		}
	});
	$effect(() => {
		if (open && includeRuntime) void connections.refreshRuntime();
	});

	// Auto-discover on a debounced change of the connect form's endpoint or key.
	// Best effort: a failure degrades to the free-text model floor, never a toast.
	$effect(() => {
		if (view !== 'connect') return;
		const url = formBaseUrl.trim();
		const key = formApiKey.trim();
		if (!url) {
			discovered = null;
			discoveryError = null;
			discovering = false;
			return;
		}
		discovered = null;
		let cancelled = false;
		discovering = true;
		discoveryError = null;
		const handle = setTimeout(async () => {
			const { data, error } = await connections.discover(url, key || undefined);
			if (cancelled) return;
			discovering = false;
			if (error) {
				discovered = null;
				discoveryError = discoveryMessage(error);
				return;
			}
			discovered = data;
		}, 500);
		return () => {
			cancelled = true;
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
		{#if view === 'list'}
			<Command.Root>
				<Command.Input placeholder="Search models..." />
				<Command.List class="max-h-80">
					<Command.Empty>No models found.</Command.Empty>
					{#if includeRuntime && connections.runtimeId}
						<Command.Group heading="This device">
							{#each connections.runtimeModels as id (id)}
								<Command.Item value="native {id}" onSelect={() => selectModel(connections.runtimeId!, id)}>
									<Check class="size-4 {isSelected(connections.runtimeId!, id) ? 'opacity-100' : 'opacity-0'}" />
									<span class="break-all">{id}</span>
								</Command.Item>
							{/each}
							<div class="flex gap-1 p-2">
								<Input bind:value={formModel} aria-label="Native model ID" placeholder="Enter an installed model ID" />
								<Button size="sm" disabled={!formModel.trim()} onclick={() => selectModel(connections.runtimeId!, formModel.trim())}>Use</Button>
							</div>
						</Command.Group>
					{/if}

					{#if connections.ai.account && connections.accountId}
						<Command.Group heading={`Connected account · ${connections.accountLabel}`}>
							{#each models as hostedModel (hostedModel.id)}
								<Command.Item
									value={`hosted ${hostedModel.id}`}
									keywords={[hostedModel.id, hostedModel.label]}
									onSelect={() => selectModel(connections.accountId!, hostedModel.id)}
								>
									<Check
										class="size-4 shrink-0 {isSelected(connections.accountId!, hostedModel.id)
											? 'opacity-100'
											: 'opacity-0'}"
									/>
									<span class="flex-1 truncate">{hostedModel.label}</span>

								</Command.Item>
							{/each}
       <div class="flex gap-1 p-2">
        <Input bind:value={formModel} aria-label="Account model ID" placeholder="Enter a model ID" />
        <Button size="sm" disabled={!formModel.trim()} onclick={() => selectModel(connections.accountId!, formModel.trim())}>Use</Button>
       </div>
						</Command.Group>
					{/if}

					{#each connections.custom as connection (connection.id)}
						{@const ids = connection.models ?? []}
						{@const label = connection.name}
						<Command.Group heading={label}>
							{#each ids as id (id)}
								<Command.Item
									value="{connection.id} {id}"
									keywords={[id, label]}
									onSelect={() => selectModel(connection.id, id)}
								>
									<Check
										class="size-4 shrink-0 {isSelected(connection.id, id)
											? 'opacity-100'
											: 'opacity-0'}"
									/>
									<span
										class="line-clamp-2 flex-1 break-all {isSelected(connection.id, id)
											? 'font-medium'
											: ''}"
										title={id}>{id}</span>
								</Command.Item>
							{:else}
								<Command.Item disabled value="{connection.id} empty">
									<span class="text-xs text-muted-foreground">
										No models discovered
									</span>
								</Command.Item>
							{/each}
							<Command.Item
								value="configure {connection.id}"
								onSelect={() => {
									choosePreset('custom');
									formBaseUrl = connection.baseUrl;
         formName = connection.name;
         editingId = connection.id;
									formApiKey = connection.apiKey ?? '';
									view = 'connect';
								}}
							>
								<Plus class="size-4" />
								<span class="text-xs">Edit {label} or enter a model</span>
							</Command.Item>
							<Command.Item
								value="refresh {connection.id}"
								disabled={refreshingBaseUrls.has(connection.id)}
								onSelect={() => refreshConnection(connection.id)}
							>
								{#if refreshingBaseUrls.has(connection.id)}
									<Spinner class="size-4" />
								{:else}
									<RefreshCw class="size-4" />
								{/if}
								<span class="text-xs">Refresh {label}</span>
							</Command.Item>
							<Command.Item
								value="remove {connection.id}"
								onSelect={() => connections.remove(connection.id)}
							>
								<Trash2 class="size-4" />
								<span class="text-xs">Remove {label}</span>
							</Command.Item>
						</Command.Group>
					{/each}

					<Command.Separator />
					{@render additionalOptions?.(() => { open = false; })}
					<Command.Item
						value="connect a provider"
						onSelect={() => (view = 'connect')}
					>
						<Plus class="size-4" />
						<span>Connect a provider...</span>
					</Command.Item>
				</Command.List>
			</Command.Root>
		{:else}
			<div class="space-y-3 p-3">
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						onclick={() => (view = 'list')}
						aria-label="Back to models"
					>
						<ArrowLeft class="size-4" />
					</Button>
					<p class="text-sm font-medium">Connect a provider</p>
				</div>

				{#if formPreset === null}
					<Command.Root class="rounded-md border">
						<Command.List>
							{#each CONNECTION_PRESETS as preset (preset.id)}
								<Command.Item
									value={preset.label}
									onSelect={() => choosePreset(preset.id)}
								>
									<span class="flex-1">{preset.label}</span>
									<span class="text-xs text-muted-foreground">
										{hostLabel(preset.baseUrl)}
									</span>
								</Command.Item>
							{/each}
							<Command.Separator />
							<Command.Item
								value="custom url"
								onSelect={() => choosePreset('custom')}
							>
								<Plus class="size-4 shrink-0 opacity-70" />
								<span class="flex-1">Custom URL</span>
							</Command.Item>
						</Command.List>
					</Command.Root>
				{:else}
					<div class="space-y-1">
						<Label for="conn-name" class="text-xs">Name</Label>
      <Input id="conn-name" bind:value={formName} placeholder="Connection name" />
      <Label for="conn-url" class="text-xs">Base URL</Label>
						<Input
							id="conn-url"
							bind:value={formBaseUrl}
							oninput={() => (formApiKey = '')}
							placeholder="http://localhost:11434/v1"
						/>
					</div>

					<div class="space-y-1">
						<Label for="conn-key" class="text-xs">
							API key (if required by your server)
						</Label>
						<div class="flex gap-1">
							<Input
								id="conn-key"
								type={showKey ? 'text' : 'password'}
								bind:value={formApiKey}
								placeholder="sk-..."
							/>
							<Button
								variant="ghost"
								size="icon-sm"
								onclick={() => (showKey = !showKey)}
								aria-label={showKey ? 'Hide key' : 'Show key'}
							>
								{#if showKey}
									<EyeOff class="size-4" />
								{:else}
									<Eye class="size-4" />
								{/if}
							</Button>
						</div>
					</div>

					<div class="space-y-1">
						<Label class="text-xs">Model</Label>
						{#if discovering}
							<p class="flex items-center gap-2 text-xs text-muted-foreground">
								<Spinner class="size-3.5" /> Loading models...
							</p>
						{:else if discovered && discovered.length > 0}
							<p class="text-xs text-muted-foreground">
								Pick a model to start using it.
							</p>
							<Command.Root class="rounded-md border">
								<Command.Input placeholder="Search models..." />
								<Command.List class="max-h-48">
									<Command.Empty>No models found.</Command.Empty>
									{#each discovered as id (id)}
										<Command.Item
											value={id}
											keywords={[id]}
											onSelect={() => commitConnection(id)}
										>
											<span class="line-clamp-2 break-all" title={id}>{id}</span>
										</Command.Item>
									{/each}
								</Command.List>
							</Command.Root>
						{:else}
							{#if discoveryError}
								<p class="text-xs text-muted-foreground">
									{discoveryError}
								</p>
							{:else if formBaseUrl.trim()}
								<p class="text-xs text-muted-foreground">
									No models found at this endpoint, type one manually.
								</p>
							{:else}
								<p class="text-xs text-muted-foreground">
									Enter an endpoint to load models.
								</p>
							{/if}
						{/if}
						<div class="flex gap-1">
							<Input bind:value={formModel} aria-label="Model ID" placeholder="Enter a model ID" />
							<Button
								size="sm"
								disabled={!formBaseUrl.trim() || !formModel.trim()}
								onclick={() => commitConnection(formModel)}
							>
								Add
							</Button>
						</div>
					</div>

					<p class="text-xs text-muted-foreground">
						Requests go straight to this URL. Your Epicenter sign-in is never
						sent there.
					</p>
				{/if}
			</div>
		{/if}
	</Popover.Content>
</Popover.Root>
