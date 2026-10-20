<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Input } from '@epicenter/ui/input';
	import { Checkbox } from '@epicenter/ui/checkbox';
	import * as Select from '@epicenter/ui/select';
	import type { TableView } from './views.svelte';
	let {
		view,
		columns,
		change,
	}: {
		view: TableView;
		columns: string[];
		change: (value: TableView) => void;
	} = $props();
	const operators = [
		'eq',
		'ne',
		'lt',
		'lte',
		'gt',
		'gte',
		'contains',
		'exists',
	] as const;
	const labels = {
		eq: 'equals',
		ne: 'does not equal',
		lt: 'less than',
		lte: 'at most',
		gt: 'greater than',
		gte: 'at least',
		contains: 'contains',
		exists: 'has a value',
	};
	function filter(
		index: number,
		patch: Partial<NonNullable<TableView['filters']>[number]>,
	) {
		change({
			...view,
			filters: view.filters?.map((entry, at) =>
				at === index ? { ...entry, ...patch } : entry,
			),
		});
	}
	function kind(value: unknown) {
		return value === null
			? 'null'
			: typeof value === 'object'
				? 'nested'
				: typeof value;
	}
</script>

<details class="border-b pb-3">
	<summary class="cursor-pointer text-sm">Columns, filters and sorting</summary>
	<div class="flex flex-col gap-3 pt-3">
		<fieldset class="flex flex-wrap gap-3">
			<legend class="text-sm">Columns</legend>
			<Button
				size="xs"
				variant="ghost"
				onclick={() => {
					const { columns: _, ...rest } = view;
					change(rest);
				}}>Show all</Button
			>
			{#each [...new Set([...columns, ...(view.columns ?? [])])] as column}
				<label class="flex items-center gap-2 text-sm"
					><Checkbox
						checked={view.columns === undefined ||
							view.columns.includes(column)}
						onCheckedChange={(checked) =>
							change({
								...view,
								columns: checked
									? [...new Set([...(view.columns ?? columns), column])]
									: (view.columns ?? columns).filter((name) => name !== column),
							})}
					/>{column}</label
				>
			{/each}
		</fieldset>
		<fieldset class="flex flex-col gap-2">
			<legend class="text-sm">Filters: match every rule</legend>
			{#each view.filters ?? [] as rule, index}
				<div class="flex flex-wrap items-center gap-2">
					<Input
						aria-label="Filter field {index + 1}"
						value={rule.field}
						oninput={(event) =>
							filter(index, { field: event.currentTarget.value })}
						class="w-40"
					/>
					<Select.Root
						type="single"
						value={rule.operator}
						onValueChange={(operator) =>
							filter(index, {
								operator: operator as typeof rule.operator,
								value:
									operator === 'exists'
										? true
										: Object.hasOwn(rule, 'value')
											? rule.value
											: '',
							})}
						><Select.Trigger aria-label="Filter comparison {index + 1}"
							>{labels[rule.operator]}</Select.Trigger
						><Select.Content
							>{#each operators as operator}<Select.Item value={operator}
									>{labels[operator]}</Select.Item
								>{/each}</Select.Content
						></Select.Root
					>
					{#if rule.operator === 'exists'}
						<label class="flex gap-2 text-sm"
							><Checkbox
								checked={rule.value !== false}
								onCheckedChange={(checked) => filter(index, { value: checked })}
							/>Present</label
						>
					{:else}
						<Select.Root
							type="single"
							value={kind(rule.value)}
							onValueChange={(type) =>
								filter(index, {
									value:
										type === 'number'
											? 0
											: type === 'boolean'
												? true
												: type === 'null'
													? null
													: '',
								})}
							><Select.Trigger aria-label="Filter value type {index + 1}"
								>{kind(rule.value)}</Select.Trigger
							><Select.Content
								>{#each ['string', 'number', 'boolean', 'null'] as type}<Select.Item
										value={type}>{type}</Select.Item
									>{/each}</Select.Content
							></Select.Root
						>
						{#if typeof rule.value === 'boolean'}<Checkbox
								aria-label="Filter value {index + 1}"
								checked={rule.value}
								onCheckedChange={(value) => filter(index, { value })}
							/>
						{:else if typeof rule.value === 'string' || typeof rule.value === 'number'}<Input
								aria-label="Filter value {index + 1}"
								type={typeof rule.value === 'number' ? 'number' : 'text'}
								value={rule.value}
								oninput={(event) => {
									const value = event.currentTarget.value;
									if (typeof rule.value === 'number') {
										if (value !== '' && Number.isFinite(Number(value)))
											filter(index, { value: Number(value) });
									} else filter(index, { value });
								}}
								class="w-48"
							/>
						{:else if rule.value !== null}<code
								>{JSON.stringify(rule.value)}</code
							>{/if}
					{/if}
					<Button
						size="xs"
						variant="ghost"
						onclick={() =>
							change({
								...view,
								filters: view.filters?.filter((_, at) => at !== index),
							})}>Remove filter</Button
					>
				</div>
			{/each}
			<div>
				<Button
					size="xs"
					variant="outline"
					onclick={() =>
						change({
							...view,
							filters: [
								...(view.filters ?? []),
								{ field: columns[0] ?? '', operator: 'exists' },
							],
						})}>Add filter</Button
				>
			</div>
		</fieldset>
		<fieldset class="flex flex-col gap-2">
			<legend class="text-sm">Sort in this order</legend>
			{#each view.sort ?? [] as rule, index}<div
					class="flex items-center gap-2"
				>
					<Input
						aria-label="Sort field {index + 1}"
						value={rule.field}
						oninput={(event) =>
							change({
								...view,
								sort: view.sort?.map((entry, at) =>
									at === index
										? { ...entry, field: event.currentTarget.value }
										: entry,
								),
							})}
						class="w-40"
					/>
					<Select.Root
						type="single"
						value={rule.direction}
						onValueChange={(direction) =>
							change({
								...view,
								sort: view.sort?.map((entry, at) =>
									at === index
										? { ...entry, direction: direction as 'asc' | 'desc' }
										: entry,
								),
							})}
						><Select.Trigger aria-label="Sort direction {index + 1}"
							>{rule.direction === 'asc'
								? 'Ascending'
								: 'Descending'}</Select.Trigger
						><Select.Content
							><Select.Item value="asc">Ascending</Select.Item><Select.Item
								value="desc">Descending</Select.Item
							></Select.Content
						></Select.Root
					>
					<Button
						size="xs"
						variant="ghost"
						onclick={() =>
							change({
								...view,
								sort: view.sort?.filter((_, at) => at !== index),
							})}>Remove sort</Button
					>
				</div>{/each}
			<div>
				<Button
					size="xs"
					variant="outline"
					onclick={() =>
						change({
							...view,
							sort: [
								...(view.sort ?? []),
								{ field: columns[0] ?? '', direction: 'asc' },
							],
						})}>Add sort</Button
				>
			</div>
		</fieldset>
	</div>
</details>
