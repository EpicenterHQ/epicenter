<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import * as AlertDialog from '@epicenter/ui/alert-dialog';
	import { Badge, type BadgeVariant } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { CopyButton } from '@epicenter/ui/copy-button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Field from '@epicenter/ui/field';
	import * as Item from '@epicenter/ui/item';
	import * as Select from '@epicenter/ui/select';
	import * as Sheet from '@epicenter/ui/sheet';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import {
		isHomeProposalLens,
		type HomeProposal,
		type HomeProposalCatalog,
		type HomeProposalLens,
	} from '../proposal-contract.ts';
	import { applyProposalWithStatusRecovery } from '../proposal-apply.ts';
	import {
		homeProposalApplyPath,
		homeProposalCompilePath,
		homeProposalPath,
		HOME_PROPOSALS_ROUTE,
	} from '../routes.ts';

	let open = $state(false);
	let hasRequestedCatalog = $state(false);
	let catalog = $state.raw<HomeProposalCatalog>();
	let selectedLens = $state<HomeProposalLens>('chat');
	let selectionJson = $state('');
	let operation = $state<string>();
	let error = $state<string>();
	let notice = $state<string>();
	let confirmationOpen = $state(false);
	let confirmation = $state.raw<{
		kind: 'apply' | 'delete';
		proposal: HomeProposal;
	}>();
	const isBusy = $derived(operation !== undefined);
	const selectedLensEntry = $derived(
		catalog?.lenses.find((lens) => lens.id === selectedLens),
	);
	const proposalState = {
		draft: { label: 'Draft', variant: 'secondary' },
		compiled: { label: 'Compiled', variant: 'status.completed' },
		invalid: { label: 'Invalid', variant: 'status.failed' },
	} as const satisfies Record<
		HomeProposal['state'],
		{ label: string; variant: BadgeVariant }
	>;

	$effect(() => {
		if (!open || hasRequestedCatalog) return;
		hasRequestedCatalog = true;
		void refresh();
	});

	async function responseBody(response: Response): Promise<unknown> {
		const contentType = response.headers.get('content-type');
		return contentType?.includes('application/json')
			? response.json()
			: response.text();
	}

	function errorMessage(value: unknown): string {
		if (
			typeof value === 'object' &&
			value !== null &&
			'error' in value &&
			typeof value.error === 'object' &&
			value.error !== null &&
			'message' in value.error &&
			typeof value.error.message === 'string'
		) {
			return value.error.message;
		}
		return typeof value === 'string' && value !== ''
			? value
			: 'The Proposal operation failed.';
	}

	function selectionTemplate(lens: HomeProposalCatalog['lenses'][number]) {
		return JSON.stringify(
			{ namespace: lens.namespace, collections: {} },
			null,
			2,
		);
	}

	async function requestJson<TResult>(
		path: string,
		init?: RequestInit,
	): Promise<TResult> {
		const response = await fetch(path, {
			credentials: 'same-origin',
			...init,
		});
		const body = await responseBody(response);
		if (!response.ok) throw new Error(errorMessage(body));
		return body as TResult;
	}

	async function refresh(): Promise<void> {
		if (isBusy) return;
		operation = 'refresh';
		error = undefined;
		try {
			const next = await requestJson<HomeProposalCatalog>(
				HOME_PROPOSALS_ROUTE.pattern,
			);
			catalog = next;
			const selected = next.lenses.find((lens) => lens.id === selectedLens);
			if (selected === undefined) {
				const first = next.lenses[0];
				if (first !== undefined) selectedLens = first.id;
			}
			if (selectionJson === '') {
				const lens =
					next.lenses.find((candidate) => candidate.id === selectedLens) ??
					next.lenses[0];
				if (lens !== undefined) selectionJson = selectionTemplate(lens);
			}
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Proposal refresh failed.';
		} finally {
			operation = undefined;
		}
	}

	async function requestCatalog(): Promise<HomeProposalCatalog> {
		return requestJson<HomeProposalCatalog>(HOME_PROPOSALS_ROUTE.pattern, {
			cache: 'no-store',
		});
	}

	async function create(): Promise<void> {
		if (isBusy) return;
		let selection: unknown;
		try {
			selection = JSON.parse(selectionJson);
		} catch {
			error = 'Selection must be valid JSON.';
			return;
		}
		operation = 'create';
		error = undefined;
		notice = undefined;
		try {
			const proposal = await requestJson<HomeProposal>(
				HOME_PROPOSALS_ROUTE.pattern,
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ lens: selectedLens, selection }),
				},
			);
			if (catalog !== undefined) {
				catalog = {
					...catalog,
					proposals: [...catalog.proposals, proposal].sort((left, right) =>
						left.id.localeCompare(right.id),
					),
				};
			}
			notice = 'Draft created. Edit the SQLite file, then return to compile it.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Proposal creation failed.';
		} finally {
			operation = undefined;
		}
	}

	function replaceProposal(proposal: HomeProposal): void {
		if (catalog === undefined) return;
		catalog = {
			...catalog,
			proposals: catalog.proposals.map((current) =>
				current.id === proposal.id ? proposal : current,
			),
		};
	}

	function removeProposal(id: string): void {
		if (catalog === undefined) return;
		catalog = {
			...catalog,
			proposals: catalog.proposals.filter((proposal) => proposal.id !== id),
		};
	}

	async function compile(proposal: HomeProposal): Promise<void> {
		if (isBusy) return;
		operation = `compile:${proposal.id}`;
		error = undefined;
		notice = undefined;
		try {
			const compiled = await requestJson<HomeProposal>(
				homeProposalCompilePath(proposal.id),
				{ method: 'POST' },
			);
			replaceProposal(compiled);
			notice =
				compiled.state === 'compiled'
					? `Compiled ${compiled.changeCount} changes. Review the count before Apply.`
					: 'Proposal compiled.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Proposal compile failed.';
		} finally {
			operation = undefined;
		}
	}

	async function apply(proposal: HomeProposal): Promise<void> {
		if (isBusy) return;
		operation = `apply:${proposal.id}`;
		error = undefined;
		notice = undefined;
		const outcome = await applyProposalWithStatusRecovery(
			() =>
				requestJson(homeProposalApplyPath(proposal.id), { method: 'POST' }),
			requestCatalog,
		);
		if (outcome.ok) {
			removeProposal(outcome.result.proposalId);
			notice = `Applied ${outcome.result.admittedChanges} changes. The Proposal file was deleted; ordinary synchronization now owns any remaining work.`;
		} else {
			const applyError =
				outcome.cause instanceof Error
					? outcome.cause.message
					: 'Proposal Apply failed.';
			if (outcome.catalog === undefined) {
				catalog = undefined;
				error = `${applyError} Proposal status could not be refreshed. Use Refresh before another action.`;
			} else {
				catalog = outcome.catalog;
				error = applyError;
			}
		}
		operation = undefined;
	}

	async function deleteProposal(proposal: HomeProposal): Promise<void> {
		if (isBusy) return;
		operation = `delete:${proposal.id}`;
		error = undefined;
		notice = undefined;
		try {
			const response = await fetch(homeProposalPath(proposal.id), {
				method: 'DELETE',
				credentials: 'same-origin',
			});
			if (!response.ok) throw new Error(errorMessage(await responseBody(response)));
			removeProposal(proposal.id);
			notice = 'Proposal artifact deleted.';
		} catch (cause) {
			error = cause instanceof Error ? cause.message : 'Proposal deletion failed.';
		} finally {
			operation = undefined;
		}
	}

	function confirm(kind: 'apply' | 'delete', proposal: HomeProposal): void {
		confirmation = { kind, proposal };
		confirmationOpen = true;
	}
</script>

<Sheet.Root bind:open>
	<Sheet.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="outline" size="sm">Proposals</Button>
		{/snippet}
	</Sheet.Trigger>
	<Sheet.Content class="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
		<Sheet.Header class="border-b px-5 py-4 text-left">
			<Sheet.Title>Data proposals</Sheet.Title>
			<Sheet.Description>
				Create an exact Lens selection, edit its SQLite artifact externally, then
				compile and apply ordinary record writes.
			</Sheet.Description>
		</Sheet.Header>

		<div class="grid gap-4 border-b p-4">
			<Field.Field>
				<Field.Label for="proposal-lens">Lens</Field.Label>
				<Select.Root
					type="single"
					value={selectedLens}
					disabled={isBusy || catalog === undefined}
					onValueChange={(value) => {
						if (!isHomeProposalLens(value) || value === selectedLens) return;
						selectedLens = value;
						const lens = catalog?.lenses.find((entry) => entry.id === value);
						if (lens !== undefined) selectionJson = selectionTemplate(lens);
					}}
				>
					<Select.Trigger id="proposal-lens" class="w-full">
						{selectedLensEntry?.title ?? 'Loading lenses...'}
					</Select.Trigger>
					<Select.Content>
						{#each catalog?.lenses ?? [] as lens (lens.id)}
							<Select.Item value={lens.id} label={lens.title} />
						{/each}
					</Select.Content>
				</Select.Root>
				{#if selectedLensEntry}
					<Field.Description>
						{selectedLensEntry.namespace}. Collections:
						{selectedLensEntry.collections
							.map((collection) =>
								collection.kind === 'table'
									? `${collection.key} (table)`
									: `${collection.key} (values: ${collection.recordKeys.join(', ')})`,
							)
							.join(', ')}.
					</Field.Description>
				{/if}
			</Field.Field>

			<Field.Field>
				<Field.Label for="proposal-selection">Exact selection</Field.Label>
				<Textarea
					id="proposal-selection"
					bind:value={selectionJson}
					rows={8}
					spellcheck={false}
					class="font-mono text-xs"
					disabled={isBusy || catalog === undefined}
				/>
				<Field.Description>
					Name record keys explicitly. For tables, set allowCreate to opt into new
					rows. There are no filters or wildcards.
				</Field.Description>
			</Field.Field>
			<div class="flex flex-wrap gap-2">
				<Button onclick={create} disabled={isBusy || catalog === undefined}>
					{#if operation === 'create'}<Spinner class="size-3.5" />{/if}
					Create draft
				</Button>
				<Button variant="ghost" onclick={refresh} disabled={isBusy}>
					Refresh
				</Button>
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-y-auto p-4">
			{#if error}
				<Alert.Root variant="destructive" class="mb-4">
					<Alert.Title>Proposal operation failed</Alert.Title>
					<Alert.Description>{error}</Alert.Description>
				</Alert.Root>
			{:else if notice}
				<Alert.Root class="mb-4">
					<Alert.Title>Proposal updated</Alert.Title>
					<Alert.Description>{notice}</Alert.Description>
				</Alert.Root>
			{/if}

			{#if catalog === undefined && operation === 'refresh'}
				<Empty.Root class="border-0">
					<Empty.Media><Spinner /></Empty.Media>
					<Empty.Title>Loading proposals</Empty.Title>
				</Empty.Root>
			{:else if catalog === undefined}
				<Empty.Root class="border-0">
					<Empty.Title>Proposal catalog unavailable</Empty.Title>
					<Empty.Description>Use Refresh to try again.</Empty.Description>
				</Empty.Root>
			{:else if catalog.proposals.length === 0}
				<Empty.Root class="border-0">
					<Empty.Title>No Proposal artifacts</Empty.Title>
					<Empty.Description>
						Create a draft above. The file remains outside the live Epicenter until
						Apply.
					</Empty.Description>
				</Empty.Root>
			{:else}
				<Item.Group>
					{#each catalog.proposals as proposal (proposal.id)}
						<Item.Root variant="outline" class="items-start">
							<Item.Content class="min-w-0 gap-1">
								<Item.Title class="gap-2">
									<code class="font-mono text-xs">{proposal.id}</code>
									<Badge variant={proposalState[proposal.state].variant}>
										{proposalState[proposal.state].label}
									</Badge>
								</Item.Title>
								<Item.Description class="break-all font-mono text-xs">
									{proposal.path}
								</Item.Description>
								{#if proposal.state === 'invalid'}
									<p class="text-xs text-destructive">{proposal.message}</p>
								{:else}
									<p class="text-xs text-muted-foreground tabular-nums">
										Fence {proposal.sourceReplicaId} /
										{proposal.sourceAuthorityLifetime ?? 'unattached'}.
										{proposal.appliedCount} of {proposal.changeCount} changes admitted.
									</p>
								{/if}
							</Item.Content>
							<Item.Actions class="flex-wrap justify-end">
								<CopyButton text={proposal.path} size="sm" tabindex={0}>
									Copy path
								</CopyButton>
								{#if proposal.state === 'draft'}
									<Button
										size="sm"
										onclick={() => void compile(proposal)}
										disabled={isBusy}
									>
										{#if operation === `compile:${proposal.id}`}<Spinner
												class="size-3.5"
											/>{/if}
										Compile
									</Button>
								{:else if proposal.state === 'compiled'}
									<Button
										size="sm"
										onclick={() => confirm('apply', proposal)}
										disabled={isBusy}
									>
										Apply
									</Button>
								{/if}
								<Button
									size="sm"
									variant="ghost-destructive"
									onclick={() => confirm('delete', proposal)}
									disabled={isBusy}
								>
									Delete
								</Button>
							</Item.Actions>
						</Item.Root>
					{/each}
				</Item.Group>
			{/if}
		</div>
	</Sheet.Content>
</Sheet.Root>

<AlertDialog.Root bind:open={confirmationOpen}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>
				{confirmation?.kind === 'apply' ? 'Apply proposal?' : 'Delete proposal?'}
			</AlertDialog.Title>
			<AlertDialog.Description>
				{#if confirmation?.kind === 'apply' &&
					confirmation.proposal.state === 'compiled'}
					Admit the remaining {confirmation.proposal.changeCount -
						confirmation.proposal.appliedCount} compiled changes as ordinary local
					writes. {confirmation.proposal.appliedCount} changes are already admitted.
					The artifact is deleted after admission finishes.
				{:else}
					Delete this external SQLite artifact without changing live data.
				{/if}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action
				class={confirmation?.kind === 'delete'
					? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
					: undefined}
				onclick={() => {
					const target = confirmation;
					if (target === undefined) return;
					if (target.kind === 'apply') void apply(target.proposal);
					else void deleteProposal(target.proposal);
				}}
			>
				{confirmation?.kind === 'apply' ? 'Apply changes' : 'Delete artifact'}
			</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
