<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Button } from '@epicenter/ui/button';
	import { Card } from '@epicenter/ui/card';
	import { confirmationDialog } from '@epicenter/ui/confirmation-dialog';
	import { Input } from '@epicenter/ui/input';
	import { Label } from '@epicenter/ui/label';
	import * as Modal from '@epicenter/ui/modal';
	import * as SectionHeader from '@epicenter/ui/section-header';
	import { Textarea } from '@epicenter/ui/textarea';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { report } from '$lib/report';
	import { isBuiltinRecipeId } from '$lib/state/builtin-recipes';
	import { generateDefaultRecipe } from '$lib/state/recipes.svelte';
	import type { Recipe } from '$lib/data';
	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();

	let editorOpen = $state(false);
	let isEditing = $state(false);
	// The recipe being created or edited. A page-owned copy so edits never touch
	// the live row until Save.
	let working = $state<Recipe>(generateDefaultRecipe());

	function openNew() {
		working = generateDefaultRecipe();
		isEditing = false;
		editorOpen = true;
	}

	function openEdit(recipe: Recipe) {
		working = { ...recipe };
		isEditing = true;
		editorOpen = true;
	}

	async function save() {
		const name = working.name.trim();
		const instructions = working.instructions.trim();
		if (!name) {
			report.info({ title: 'Name your recipe', description: 'Give it a short name like "Email" or "Standup".' });
			return;
		}
		if (!instructions) {
			report.info({ title: 'Add an instruction', description: 'One line telling the AI what to do with the text.' });
			return;
		}
		await app.recipes.set({ ...$state.snapshot(working), name, instructions });
		editorOpen = false;
		report.success({ title: isEditing ? 'Recipe updated' : 'Recipe created' });
	}

	function remove(recipe: Recipe) {
		confirmationDialog.open({
			title: `Delete ${recipe.name}?`,
			description: 'This removes the recipe everywhere. It cannot be undone.',
			confirm: { text: 'Delete', variant: 'destructive' },
			onConfirm: async () => {
				await app.recipes.delete(recipe.id);
				report.success({ title: 'Recipe deleted' });
			},
		});
	}
</script>

<svelte:head> <title>Recipes</title> </svelte:head>

<main class="flex w-full flex-1 flex-col gap-2 px-4 py-4 sm:px-8 mx-auto">
	<SectionHeader.Root>
		<SectionHeader.Title
			level={1}
			class="scroll-m-20 text-4xl tracking-tight lg:text-5xl"
		>
			Recipes
		</SectionHeader.Title>
		<SectionHeader.Description>
			Reusable text actions you run on demand over a selection, your clipboard,
			or a transcript. Cleanup is automatic (that is Polish); recipes are the
			reshapes you pick.
		</SectionHeader.Description>
	</SectionHeader.Root>

	<Card class="flex flex-col gap-4 p-6">
		<div class="flex items-center justify-between gap-2">
			<h2 class="text-lg font-semibold">Your library</h2>
			<Button variant="outline" onclick={openNew}>
				<PlusIcon class="size-4" /> New recipe
			</Button>
		</div>

		<ul class="flex flex-col divide-y">
			{#each app.recipes.pickable as recipe (recipe.id)}
				{@const builtin = isBuiltinRecipeId(recipe.id)}
				<li class="flex items-start justify-between gap-4 py-3">
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							{#if recipe.icon}
								<span aria-hidden="true">{recipe.icon}</span>
							{/if}
							<span class="font-medium">{recipe.name}</span>
							{#if builtin}
								<Badge variant="secondary">Built-in</Badge>
							{/if}
						</div>
						<p class="text-muted-foreground mt-0.5 line-clamp-2 text-sm">
							{recipe.instructions}
						</p>
					</div>
					{#if !builtin}
						<div class="flex shrink-0 items-center gap-1">
							<Button
								tooltip="Edit recipe"
								variant="ghost"
								size="icon"
								onclick={() => openEdit(recipe)}
							>
								<PencilIcon class="size-4" />
							</Button>
							<Button
								tooltip="Delete recipe"
								variant="ghost"
								size="icon"
								onclick={() => remove(recipe)}
							>
								<TrashIcon class="size-4" />
							</Button>
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</Card>
</main>

<Modal.Root bind:open={editorOpen}>
	<Modal.Content>
		<Modal.Header>
			<Modal.Title>{isEditing ? 'Edit recipe' : 'New recipe'}</Modal.Title>
			<Modal.Description>
				A name and one instruction. The instruction is the whole recipe: text in,
				text out.
			</Modal.Description>
		</Modal.Header>
		<div class="space-y-4 p-4">
			<div class="flex gap-2">
				<div class="grid w-20 shrink-0 gap-2">
					<Label for="recipe-icon">Icon</Label>
					<Input
						id="recipe-icon"
						placeholder="🪄"
						class="text-center"
						bind:value={
							() => working.icon ?? '',
							(value) => (working = { ...working, icon: value.trim() || null })
						}
					/>
				</div>
				<div class="grid flex-1 gap-2">
					<Label for="recipe-name">Name</Label>
					<Input
						id="recipe-name"
						placeholder="e.g. Email"
						bind:value={working.name}
					/>
				</div>
			</div>
			<div class="grid gap-2">
				<Label for="recipe-instructions">Instruction</Label>
				<Textarea
					id="recipe-instructions"
					placeholder="Rewrite the text as a clear, friendly email."
					rows={4}
					bind:value={working.instructions}
				/>
			</div>
		</div>
		<Modal.Footer>
			<Button variant="outline" onclick={() => (editorOpen = false)}>Cancel</Button>
			<Button onclick={save}>{isEditing ? 'Save' : 'Create'}</Button>
		</Modal.Footer>
	</Modal.Content>
</Modal.Root>
