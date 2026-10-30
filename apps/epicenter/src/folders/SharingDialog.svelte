<script lang="ts">
	/**
	 * Who may read or write the repository a synced folder pushes to:
	 * `epicenter share <dir>` to list, `share <dir> <handle> --read|--write`
	 * to grant, and `unshare <dir> <handle>` to revoke. The parent mounts it
	 * for one folder at a time and unmounts it on close.
	 */
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import { Spinner } from '@epicenter/ui/spinner';
	import { onMount } from 'svelte';
	import {
		type CliError,
		commands,
		type GrantLevel,
		type RepositoryGrant,
		type SyncedFolder,
	} from '../ui/bindings.gen';

	let { folder, onClose }: { folder: SyncedFolder; onClose: () => void } = $props();

	let grants = $state.raw<RepositoryGrant[] | undefined>(undefined);
	let problem = $state<string | undefined>(undefined);
	let person = $state('');
	let level = $state<GrantLevel>('read');
	let working = $state<string | undefined>(undefined);

	const LEVELS = { read: 'Can read', write: 'Can read and write' } satisfies Record<
		GrantLevel,
		string
	>;

	async function run<T>(
		what: string,
		request: () => Promise<{ data: T; error: null } | { data: null; error: CliError }>,
	): Promise<T | undefined> {
		working = what;
		problem = undefined;
		try {
			const { data, error } = await request();
			if (error !== null) {
				problem = error.message;
				return undefined;
			}
			return data;
		} finally {
			working = undefined;
		}
	}

	async function load() {
		const listed = await run('Reading…', () => commands.folderSharing(folder.path));
		if (listed !== undefined) grants = listed.grants;
	}

	onMount(() => void load());
</script>

<Dialog.Root open onOpenChange={(open) => !open && onClose()}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Sharing {folder.name}</Dialog.Title>
			<Dialog.Description>
				People you share with see this folder's repository on Epicenter. Only you can share it.
			</Dialog.Description>
		</Dialog.Header>

		{#if grants === undefined && problem === undefined}
			<p class="flex items-center gap-2 text-sm text-muted-foreground">
				<Spinner class="size-3" /> Reading…
			</p>
		{:else if grants !== undefined}
			{#if grants.length === 0}
				<p class="text-sm text-muted-foreground">Not shared with anyone.</p>
			{:else}
				<ul class="flex flex-col gap-1" aria-label="People with access">
					{#each grants as grant (grant.person)}
						<li class="flex items-center gap-2 text-sm">
							<span class="min-w-0 flex-1 truncate font-medium">{grant.person}</span>
							<span class="text-muted-foreground">{LEVELS[grant.level]}</span>
							<Button
								variant="ghost"
								size="xs"
								disabled={working !== undefined}
								onclick={async () => {
									const revoked = await run(`Removing ${grant.person}…`, () =>
										commands.unshareFolder(folder.path, grant.person),
									);
									if (revoked !== undefined) await load();
								}}
							>
								Remove
							</Button>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}

		<form
			class="flex flex-col gap-2"
			onsubmit={async (event) => {
				event.preventDefault();
				const granted = await run(`Sharing with ${person.trim()}…`, () =>
					commands.shareFolder(folder.path, person, level),
				);
				if (granted !== undefined) {
					person = '';
					await load();
				}
			}}
		>
			<div class="flex gap-2">
				<Input
					aria-label="Their Epicenter handle"
					placeholder="Their Epicenter handle"
					bind:value={person}
					required
				/>
				<Select.Root type="single" bind:value={level}>
					<Select.Trigger class="w-44 shrink-0" aria-label="Access">
						{LEVELS[level]}
					</Select.Trigger>
					<Select.Content>
						<Select.Item value="read" label={LEVELS.read} />
						<Select.Item value="write" label={LEVELS.write} />
					</Select.Content>
				</Select.Root>
			</div>
			<Button type="submit" disabled={working !== undefined || person.trim() === ''}>
				Share
			</Button>
		</form>

		{#if working !== undefined && grants !== undefined}
			<p class="text-sm text-muted-foreground" role="status">{working}</p>
		{/if}
		{#if problem !== undefined}
			<p class="text-sm text-destructive" role="alert">{problem}</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
