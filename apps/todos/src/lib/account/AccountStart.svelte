<script lang="ts">
	/**
	 * The signed-in account's Todos in this browser, before the folder opens.
	 *
	 * It reads the account's pairing and what this browser's account folder
	 * holds, then offers only what `decideAccountFolder` allows: choosing a
	 * repository when there is no pairing, Download when this browser has no
	 * folder, opening a folder kept with exactly the paired repository, or a
	 * refusal that leaves a folder kept with anything else as it is. Reading
	 * and listing transfer nothing; only Download and, once open, Sync do.
	 */
	import type { Account } from '@epicenter/auth';
	import { Alert, AlertDescription, AlertTitle } from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { Loading } from '@epicenter/ui/loading';
	import { Spinner } from '@epicenter/ui/spinner';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import { onDestroy } from 'svelte';
	import { type TodosPlace, type StartProps, TODOS_FOLDER_ID } from '../platform/types.js';
	import {
		type AccountFolderStep,
		decideAccountFolder,
		describeExisting,
		downloadAccountFolder,
		inspectAccountFolder,
		openAccountFolder,
	} from './account-folder.js';
	import {
		type ConnectorError,
		createConnector,
		GITHUB_APP_URL,
		type Pairing,
		type Repository,
	} from './connector.js';
	import { startGitHubConnect, syncCallback } from './github-connect.js';
	import { takeConnected } from './start-choice.js';

	let {
		account,
		onopen,
		onback,
	}: {
		/** The Account captured when this screen began; a later sign-in remounts it. */
		account: Account;
		onopen: StartProps['onopen'];
		onback: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	const connector = createConnector(account);

	type View =
		| { kind: 'reading'; label: string }
		| { kind: 'failed'; message: string; retry?: () => void; retryLabel?: string }
		| { kind: 'step'; step: AccountFolderStep; directory: string }
		| { kind: 'downloading'; pairing: Pairing; controller: AbortController };

	let view = $state.raw<View>({ kind: 'reading', label: 'Checking your account…' });
	/** GitHub was connected in this tab just now, as this login. */
	const connectedAs = takeConnected(sessionStorage);
	let connecting = $state(false);
	let connectError = $state<string>();
	let repositories = $state.raw<Repository[]>();
	let listing = $state(false);
	let listError = $state.raw<ConnectorError>();
	let pairingWith = $state<number>();
	let pairError = $state<string>();
	/** A pairing whose GitHub connection is not ready, opened anyway by the person's choice. */
	let openAnyway = $state(false);
	let alive = true;
	onDestroy(() => {
		alive = false;
		if (view.kind === 'downloading') view.controller.abort();
	});

	function placeOf(pairing: Pairing): TodosPlace {
		return {
			kind: 'account',
			label: pairing.repository.fullName,
			detail: `Kept in this browser for your Epicenter account. Sync sends versions to ${pairing.repository.fullName} on GitHub, branch ${pairing.remote.branch}.`,
		};
	}

	/**
	 * Read the pairing and this browser's folder, and decide. Writes and
	 * transfers nothing. A folder kept with exactly the paired repository
	 * opens, unless an open just failed.
	 */
	async function read(label = 'Checking your account…', { autoOpen = true } = {}) {
		view = { kind: 'reading', label };
		const [paired, inspected] = await Promise.all([
			connector.pairing(TODOS_FOLDER_ID),
			inspectAccountFolder(account),
		]);
		if (!alive) return;
		if (paired.error) {
			view = { kind: 'failed', message: paired.error.message, retry: () => void read() };
			return;
		}
		if (inspected.error) {
			view = {
				kind: 'failed',
				message: `Todos cannot use what this browser keeps for your account, and left it unchanged. ${inspected.error.message}`,
				retry: () => void read(),
			};
			return;
		}
		const step = decideAccountFolder(inspected.data, paired.data);
		const directory =
			inspected.data.location.kind === 'opfs' ? inspected.data.location.directory : '';
		view = { kind: 'step', step, directory };
		if (step.kind === 'open' && autoOpen && (step.pairing.status === 'ready' || openAnyway))
			await open(step.pairing);
		else if (step.kind === 'unpaired' && connectedAs !== undefined && repositories === undefined)
			await listRepositories();
	}

	/** Open the folder kept with exactly this pairing. Never creates one. */
	async function open(pairing: Pairing) {
		view = { kind: 'reading', label: `Opening ${pairing.repository.fullName}…` };
		const opened = await openAccountFolder(account, pairing);
		if (!alive) {
			if (opened.data) await opened.data.close().catch(() => {});
			return;
		}
		if (opened.error) {
			// The folder changed since it was read (removed, or kept with another
			// remote): read again and say what is there now.
			if (opened.error.name === 'Absent' || opened.error.name === 'RemoteMismatch')
				return read(undefined, { autoOpen: false });
			view = { kind: 'failed', message: opened.error.message, retry: () => void read() };
			return;
		}
		onopen(opened.data, placeOf(pairing));
	}

	/** The person's Download: the repository's history into this browser, then open. */
	async function download(pairing: Pairing) {
		const controller = new AbortController();
		view = { kind: 'downloading', pairing, controller };
		const landed = await downloadAccountFolder(account, pairing, { signal: controller.signal });
		if (!alive) return;
		if (landed.error) {
			if (landed.error.name === 'Exists') return read();
			view = {
				kind: 'failed',
				message: controller.signal.aborted
					? 'The download stopped. What it wrote is kept; Download again continues it.'
					: landed.error.message,
				retry: () => void download(pairing),
				retryLabel: 'Download again',
			};
			return;
		}
		await open(pairing);
	}

	/** Leave for GitHub to connect it; GitHub returns to `/sync`. */
	async function connectGitHub() {
		connecting = true;
		connectError = undefined;
		const { data: authorizeUrl, error } = await startGitHubConnect({
			account,
			redirectUri: syncCallback(location.origin),
			storage: sessionStorage,
			isCurrent: () => alive,
		});
		if (!alive) return;
		if (error) {
			connecting = false;
			connectError = error.message;
			return;
		}
		location.assign(authorizeUrl);
	}

	/** The person's request to see the repositories they can choose. A read. */
	async function listRepositories() {
		listing = true;
		listError = undefined;
		const { data, error } = await connector.repositories();
		if (!alive) return;
		listing = false;
		if (error) listError = error;
		else repositories = data;
	}

	/** Pair Todos with `repository`, then read again; nothing is transferred. */
	async function pair(repository: Repository) {
		pairingWith = repository.id;
		pairError = undefined;
		const { error } = await connector.pair(TODOS_FOLDER_ID, repository);
		if (!alive) return;
		pairingWith = undefined;
		if (error) {
			if (error.name === 'Refused' && error.code === 'pairing_conflict')
				return read('Your account was connected to a repository elsewhere. Checking it…');
			pairError = error.message;
			return;
		}
		await read();
	}

	const needsGitHub = (error: ConnectorError | undefined) =>
		error?.name === 'Refused' &&
		(error.code === 'github_authorization_required' || error.code === 'github_account_mismatch');

	void read();
</script>

{#snippet githubNotReady(pairing: Pairing)}
	<Alert variant="warning">
		<AlertTitle>Connect GitHub to sync</AlertTitle>
		<AlertDescription>
			{pairing.status === 'github_account_mismatch'
				? `${pairing.repository.fullName} was chosen with a different GitHub account than the one connected now. Connect that GitHub account.`
				: `GitHub is not connected for your account, or the connection expired. Connect it to reach ${pairing.repository.fullName}.`}
		</AlertDescription>
	</Alert>
{/snippet}

{#snippet connectButton(label = 'Connect GitHub')}
	<Button disabled={connecting} onclick={() => void connectGitHub()}>
		{#if connecting}<Spinner class="size-3.5" />{/if}
		{label}
	</Button>
{/snippet}

{#if view.kind === 'reading'}
	<Loading class="h-dvh" label={view.label} />
{:else}
	<main class="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-5 px-4 py-10" data-testid="account-start">
		<div>
			<Button variant="ghost" size="sm" class="-ml-2" onclick={onback}><ArrowLeftIcon /> Choose again</Button>
		</div>

		{#if view.kind === 'failed'}
			<h1 class="text-xl font-semibold">Todos did not open</h1>
			<Alert variant="destructive"><AlertDescription class="whitespace-pre-line">{view.message}</AlertDescription></Alert>
			{#if view.retry}
				<div><Button onclick={view.retry}>{view.retryLabel ?? 'Try again'}</Button></div>
			{/if}
		{:else if view.kind === 'downloading'}
			<h1 class="text-xl font-semibold">Downloading {view.pairing.repository.fullName}</h1>
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner class="size-3.5" /> Getting the repository's history into this browser. Todos opens when it lands.
			</p>
			<div><Button variant="outline" onclick={() => view.kind === 'downloading' && view.controller.abort()}>Stop</Button></div>
		{:else}
			{@const step = view.step}
			{#if connectError}
				<Alert variant="destructive"><AlertDescription>{connectError}</AlertDescription></Alert>
			{/if}

			{#if step.kind === 'unpaired'}
				<h1 class="text-xl font-semibold">Choose a repository for Todos</h1>
				<p class="text-sm text-muted-foreground">
					Your todos will be Markdown files in a private GitHub repository you choose. Every browser signed in to
					your account downloads them from there. Todos does not send anything until you press Download or Sync.
				</p>
				{#if connectedAs}
					<p class="text-sm" data-testid="github-connected">GitHub is connected as <strong>{connectedAs}</strong>.</p>
				{/if}
				{#if step.existing}
					<Alert variant="warning" data-testid="existing-folder">
						<AlertTitle>This browser already has Todos for your account</AlertTitle>
						<AlertDescription>
							It holds {describeExisting(step.existing)}. Choosing a repository does not change it.
							{#if step.existing.kind === 'pending'}
								Download continues it only if you choose {step.existing.remote.url} on branch {step.existing.remote.branch};
								with any other repository, Todos refuses to use it and leaves it as it is.
							{:else if step.existing.remote?.branch !== undefined}
								Todos opens it only if you choose {step.existing.remote.url} on branch {step.existing.remote.branch};
								with any other repository, Todos refuses to open it and leaves it as it is.
							{:else}
								Todos does not connect an existing folder to a repository, so it will refuse to open it with the one you
								choose and leave it as it is.
							{/if}
						</AlertDescription>
					</Alert>
				{/if}

				{#if repositories === undefined}
					<div class="flex flex-wrap gap-2">
						<Button disabled={listing} onclick={() => void listRepositories()}>
							{#if listing}<Spinner class="size-3.5" />{/if}
							Show my repositories
						</Button>
						{#if !needsGitHub(listError)}
							{@render connectButton(connectedAs ? 'Connect another GitHub account' : 'Connect GitHub')}
						{/if}
					</div>
				{:else if repositories.length === 0}
					<Alert>
						<AlertDescription>
							No private repository is available to Epicenter for this GitHub account. Install the
							<a class="underline" href={GITHUB_APP_URL} target="_blank" rel="noreferrer">Epicenter Folder Sync</a>
							app on a private repository, then show your repositories again.
						</AlertDescription>
					</Alert>
					<div><Button variant="outline" disabled={listing} onclick={() => void listRepositories()}>Show my repositories again</Button></div>
				{:else}
					<ul class="divide-y rounded-lg border" data-testid="repositories">
						{#each repositories as repository (repository.id)}
							<li class="flex items-center gap-3 px-3 py-2">
								<div class="min-w-0 flex-1">
									<div class="truncate font-mono text-sm">{repository.fullName}</div>
									<div class="text-xs text-muted-foreground">
										{repository.push ? `Branch ${repository.defaultBranch}` : 'Read-only for you, so Todos cannot sync with it'}
									</div>
								</div>
								<Button
									size="sm"
									variant="outline"
									disabled={!repository.push || pairingWith !== undefined}
									onclick={() => void pair(repository)}
								>
									{#if pairingWith === repository.id}<Spinner class="size-3.5" />{/if}
									Use this repository
								</Button>
							</li>
						{/each}
					</ul>
				{/if}
				{#if listError}
					<Alert variant={needsGitHub(listError) ? 'warning' : 'destructive'}>
						<AlertDescription>
							{listError.message}
							{#if listError.name === 'Refused' && listError.installUrl}
								<a class="underline" href={listError.installUrl} target="_blank" rel="noreferrer">Install the app</a>.
							{/if}
						</AlertDescription>
					</Alert>
					{#if needsGitHub(listError)}<div>{@render connectButton()}</div>{/if}
				{/if}
				{#if pairError}
					<Alert variant="destructive"><AlertDescription>{pairError}</AlertDescription></Alert>
				{/if}
			{:else if step.kind === 'download' || step.kind === 'resume'}
				<h1 class="text-xl font-semibold">Download your todos</h1>
				<p class="text-sm text-muted-foreground">
					{step.kind === 'download'
						? `Your account keeps Todos in ${step.pairing.repository.fullName} (branch ${step.pairing.remote.branch}). This browser does not have them yet.`
						: `A download of ${step.pairing.repository.fullName} into this browser stopped before it finished. What it wrote is kept; Download again continues it.`}
				</p>
				{#if step.pairing.status !== 'ready'}
					{@render githubNotReady(step.pairing)}
					<div>{@render connectButton()}</div>
				{:else}
					<div>
						<Button data-testid="download" onclick={() => void download(step.pairing)}>
							<DownloadIcon />
							{step.kind === 'download' ? 'Download' : 'Download again'}
						</Button>
					</div>
				{/if}
			{:else if step.kind === 'open'}
				<h1 class="text-xl font-semibold">{step.pairing.repository.fullName}</h1>
				{#if step.pairing.status !== 'ready'}
					{@render githubNotReady(step.pairing)}
					<p class="text-sm text-muted-foreground">
						Your todos are in this browser. You can open and edit them now; Sync works once GitHub is connected.
					</p>
					<div class="flex flex-wrap gap-2">
						{@render connectButton()}
						<Button
							variant="outline"
							onclick={() => {
								openAnyway = true;
								void open(step.pairing);
							}}>Open without syncing</Button
						>
					</div>
				{:else}
					<p class="text-sm text-muted-foreground">Your todos are in this browser, kept with this repository.</p>
					<div><Button onclick={() => void open(step.pairing)}>Open</Button></div>
				{/if}
			{:else if step.kind === 'refused'}
				<h1 class="text-xl font-semibold">Todos did not open this browser's copy</h1>
				<Alert variant="destructive" data-testid="refused">
					<AlertDescription>
						This browser holds {describeExisting(step.existing)} for your account, but your account keeps Todos in
						{step.pairing.repository.fullName} ({step.pairing.remote.url}, branch {step.pairing.remote.branch}).
						Todos never changes which repository a copy is kept with, so it did not open it. Nothing was changed.
					</AlertDescription>
				</Alert>
				{#if view.directory}
					<p class="text-xs text-muted-foreground">
						The copy is in this browser's private storage at <code>{view.directory}</code>.
					</p>
				{/if}
			{/if}
		{/if}
	</main>
{/if}
