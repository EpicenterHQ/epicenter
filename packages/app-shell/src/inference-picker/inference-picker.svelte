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
	import { createMutation, QueryClient } from '@tanstack/svelte-query';
	import { onDestroy, type Snippet } from 'svelte';
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
	const app = $derived(connections.app);
	const models = $derived(accountModels ?? connections.hostedModels);

	let open = $state(false);
	let formVersion = 0;
	let alive = true;
	let view = $state<'list' | 'connect'>('list');

	// "Connect a provider" form state. `formPreset` null means the preset chooser
	// is showing; a value means its sub-form is.
	let formPreset = $state<PresetId | 'custom' | null>(null);
	let formBaseUrl = $state('');
 let formName = $state('');
 let editingId = $state<string | null>(null);
	let formApiKey = $state('');
	let removeApiKey = $state(false);
	const savedConnection = $derived(editingId ? connections.custom.find(entry => entry.id === editingId) : undefined);
	let formModel = $state('');
	let showKey = $state(false);

	// Discovery state for the connect form.
	let discovering = $state(false);
	let discovered = $state.raw<string[] | null>(null);
	// A tailored, per-variant message when discovery fails (401 vs unreachable vs
	// malformed), or null when discovery has not failed.
	let discoveryError = $state<string | null>(null);

	// The picker also runs in apps without a QueryClientProvider.
	const queryClient = new QueryClient();
	onDestroy(() => { alive = false; queryClient.clear(); });
	const refreshConnection = createMutation(() => ({
		mutationFn: (id: string) => connections.refresh(id),
	}), () => queryClient);
	const removeConnection = createMutation(() => ({
		mutationFn: (id: string) => app.ai.connections!.remove(id),
	}), () => queryClient);

	// Clear all of the connect form's working state. Called on close so a user who
	// connected one provider lands back on the preset chooser (not a stale sub-form
	// with a leftover typed API key) the next time they open the picker.
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
		connections.selections.set(scope, { connectionId, model: id });
		onSelectModel(id);
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
				: (CONNECTION_PRESETS.find((p) => p.id === id)?.baseUrl ?? '');
	}

	// Persist access before saving the workflow choice. A failed save keeps the form open.
	const saveConnection = createMutation(() => ({
		mutationFn: async (chosenModel: string) => {
			const attempt = { app, scope, formVersion };
			const baseUrl = formBaseUrl.trim();
			const trimmedModel = chosenModel.trim();
			if (!baseUrl || !trimmedModel) throw new Error('Enter an endpoint and model.');
			const credential = removeApiKey
				? { apiKey: '' }
				: formApiKey.trim() ? { apiKey: formApiKey.trim() } : {};
			const input = {
				baseUrl,
				name: formName.trim() || savedConnection?.name || undefined,
				...credential,
				models: [...new Set([...(savedConnection?.models ?? []), ...(discovered ?? []), trimmedModel])],
			};
			const id = editingId;
			if (id) {
				await app.ai.connections!.update(id, input);
				return { ...attempt, id, model: trimmedModel };
			}
			return { ...attempt, id: await app.ai.connections!.add(input), model: trimmedModel };
		},
		onSuccess: (saved) => {
			if (!alive || !open || saved.app !== app || saved.scope !== scope || saved.formVersion !== formVersion) return;
			editingId = saved.id;
			selectModel(saved.id, saved.model);
		},
	}), () => queryClient);

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
		const retainSavedKey = savedConnection?.hasApiKey && !key && !removeApiKey;
		const savedId = savedConnection && savedConnection.baseUrl === url && !key && !removeApiKey ? savedConnection.id : undefined;
		if (retainSavedKey && !savedId) {
			discovered = null;
			discovering = false;
			discoveryError = 'Save the changed endpoint with a model ID before discovering models with its saved key.';
			return;
		}
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
			const { data, error } = await connections.discover(url, key || undefined, savedId);
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

					{#if app.ai.account && connections.accountId}
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
									formApiKey = '';
									removeApiKey = false;
									saveConnection.reset();
									view = 'connect';
								}}
							>
								<Plus class="size-4" />
								<span class="text-xs">Edit {label} or enter a model</span>
							</Command.Item>
							<Command.Item
								value="refresh {connection.id}"
								disabled={refreshConnection.isPending && refreshConnection.variables === connection.id}
								onSelect={() => refreshConnection.mutate(connection.id)}
							>
								{#if refreshConnection.isPending && refreshConnection.variables === connection.id}
									<Spinner class="size-4" />
								{:else}
									<RefreshCw class="size-4" />
								{/if}
								<span class="text-xs">Refresh {label}</span>
							</Command.Item>
							<Command.Item
								value="remove {connection.id}"
								disabled={removeConnection.isPending}
								onSelect={() => removeConnection.mutate(connection.id)}
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
			<fieldset class="space-y-3 p-3" disabled={saveConnection.isPending}>
				<div class="flex items-center gap-2">
					<Button
						variant="ghost"
						size="icon-sm"
						disabled={saveConnection.isPending}
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
							disabled={saveConnection.isPending}
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
								disabled={saveConnection.isPending || removeApiKey}
								placeholder={savedConnection?.hasApiKey ? "Leave blank to keep saved key" : "sk-..."}
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
											disabled={saveConnection.isPending}
											onSelect={() => saveConnection.mutate(id)}
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
								disabled={saveConnection.isPending || !formBaseUrl.trim() || !formModel.trim()}
								onclick={() => saveConnection.mutate(formModel)}
							>
								{saveConnection.isPending ? 'Saving...' : editingId ? 'Save' : 'Add'}
							</Button>
						</div>
					</div>

					<p class="text-xs text-muted-foreground">
						Requests go straight to this URL. Your Epicenter sign-in is never
						sent there.
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
