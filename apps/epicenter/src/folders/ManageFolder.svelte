<!--
	Who holds a folder and which apps reach it (ADR-0811, ADR-0820): its
	members, each a member or a reader; the emails it is shared with that
	have not accepted; a share by email; and the apps it is attached to. A
	member manages all of it; a reader sees who holds it. Every change is a
	platform function (`shareFolder`, `unshareFolder`, `attachFolder`), and
	the folder is read again after each.
-->
<script lang="ts">
	import type { FolderRole, ListedFolder } from '@epicenter/definition/site';
	import { FOLDER_ROLES } from '@epicenter/definition/site';
	import { getFolder } from '@epicenter/folder/platform';
	import { Button } from '@epicenter/ui/button';
	import * as Dialog from '@epicenter/ui/dialog';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Item from '@epicenter/ui/item';
	import { Loading } from '@epicenter/ui/loading';
	import * as Select from '@epicenter/ui/select';
	import { folders } from './home.svelte';

	let {
		open = $bindable(),
		id,
		title,
	}: { open: boolean; id: string; title: string } = $props();

	let listed = $state.raw<ListedFolder | null>(null);
	let error = $state<string | null>(null);
	let email = $state('');
	let role = $state<FolderRole>('member');
	let app = $state('');

	const ROLE_LABELS = {
		member: 'Member',
		reader: 'Reader',
	} satisfies Record<FolderRole, string>;

	async function read() {
		const account = folders.account();
		if (account === null) return;
		const got = await getFolder(account, id);
		error = got.error?.message ?? null;
		listed = got.data;
	}

	/** Make the member who signs in as `person` a `next`, when that is a change. */
	async function changeRole(person: string, now: FolderRole, next: string) {
		if (!FOLDER_ROLES.includes(next as FolderRole) || next === now) return;
		await folders.share(id, person, next as FolderRole);
		await read();
	}

	$effect(() => {
		if (open) void read();
	});

	const manages = $derived(listed?.role === 'member');
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				Members sync and change it, and share it with others. Readers sync it without changing it.
			</Dialog.Description>
		</Dialog.Header>

		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{:else if listed === null}
			<Loading />
		{:else}
			<Item.Group class="gap-2">
				{#each listed.members as member (member.email)}
					<Item.Root size="sm" variant="muted">
						<Item.Content>
							<Item.Title>{member.name || member.email}{#if member.you} (you){/if}</Item.Title>
							{#if member.name}<Item.Description>{member.email}</Item.Description>{/if}
						</Item.Content>
						<Item.Actions>
							{#if manages}
								<Select.Root
									type="single"
									bind:value={() => member.role, (next) => void changeRole(member.email, member.role, next)}
								>
									<Select.Trigger size="sm" aria-label="Role of {member.email}">
										{ROLE_LABELS[member.role]}
									</Select.Trigger>
									<Select.Content>
										{#each FOLDER_ROLES as each (each)}
											<Select.Item value={each} label={ROLE_LABELS[each]} />
										{/each}
									</Select.Content>
								</Select.Root>
								<Button
									size="sm"
									variant="ghost"
									onclick={async () => {
										await folders.unshare(id, member.email);
										if (member.you) open = false;
										else await read();
									}}
								>
									{member.you ? 'Leave' : 'Remove'}
								</Button>
							{:else}
								<span class="text-sm text-muted-foreground">{ROLE_LABELS[member.role]}</span>
							{/if}
						</Item.Actions>
					</Item.Root>
				{/each}
				{#each listed.invited as invited (invited.email)}
					<Item.Root size="sm" variant="muted">
						<Item.Content>
							<Item.Title>{invited.email}</Item.Title>
							<Item.Description>Invited as a {invited.role}; not accepted yet</Item.Description>
						</Item.Content>
						<Item.Actions>
							<Button
								size="sm"
								variant="ghost"
								onclick={async () => {
									await folders.unshare(id, invited.email);
									await read();
								}}
							>
								Cancel
							</Button>
						</Item.Actions>
					</Item.Root>
				{/each}
			</Item.Group>

			{#if manages}
				<form
					class="flex items-end gap-2"
					onsubmit={async (event) => {
						event.preventDefault();
						const person = email.trim();
						if (person === '') return;
						if (await folders.share(id, person, role)) {
							email = '';
							await read();
						}
					}}
				>
					<Field.Field class="flex-1">
						<Field.Label for="share-email">Share with</Field.Label>
						<Input id="share-email" type="email" placeholder="name@example.com" bind:value={email} />
					</Field.Field>
					<Select.Root type="single" bind:value={() => role, (next) => (role = (next as FolderRole) || 'member')}>
						<Select.Trigger aria-label="Role">{ROLE_LABELS[role]}</Select.Trigger>
						<Select.Content>
							{#each FOLDER_ROLES as each (each)}
								<Select.Item value={each} label={ROLE_LABELS[each]} />
							{/each}
						</Select.Content>
					</Select.Root>
					<Button type="submit" disabled={email.trim() === ''}>Share</Button>
				</form>

				<Field.Set>
					<Field.Legend variant="label">Apps that reach it</Field.Legend>
					{#each listed.apps as attached (attached)}
						<div class="flex items-center justify-between gap-2 text-sm">
							<code>{attached}</code>
							<Button
								size="sm"
								variant="ghost"
								onclick={async () => {
									await folders.attach(id, attached, false);
									await read();
								}}
							>
								Detach
							</Button>
						</div>
					{:else}
						<Field.Description>No app reaches this folder.</Field.Description>
					{/each}
					<form
						class="flex gap-2"
						onsubmit={async (event) => {
							event.preventDefault();
							const named = app.trim();
							if (named === '') return;
							if (await folders.attach(id, named, true)) {
								app = '';
								await read();
							}
						}}
					>
						<Input aria-label="App id" placeholder="so.epicenter.todos" bind:value={app} />
						<Button type="submit" variant="outline" disabled={app.trim() === ''}>Attach</Button>
					</form>
				</Field.Set>
			{/if}
		{/if}
	</Dialog.Content>
</Dialog.Root>
