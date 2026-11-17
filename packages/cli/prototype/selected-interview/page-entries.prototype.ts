// Compare three authoring shapes over exactly the same paths in a disposable Epicenter.
import { defineAction, defineCollection, field, Ok } from '@epicenter/app';
import { defineDirectory, markdown } from './directory.prototype';

const documentFields = { summary: field.text() };
const pageParts = { article: markdown('article.md', { title: field.text() }) };

const documents = defineCollection({
	path: 'data/pages/{name}.md',
	fields: documentFields,
});
const folders = defineDirectory('data/pages/{page}', pageParts);

// Static composition only: supply a root once and export two independently usable handles.
const root = 'data/pages';
const pages = {
	documents: defineCollection({
		path: `${root}/{name}.md` as const,
		fields: documentFields,
	}),
	folders: defineDirectory(`${root}/{page}` as const, pageParts),
};

const pageEntries = {
	documents: markdown('{name}.md', documentFields),
	folders: defineDirectory('{page}/', pageParts),
};
const directory = defineDirectory('data/pages', pageEntries);
const archive = defineDirectory('data/archive', pageEntries);
const shelves = defineDirectory('data/shelves/{shelf}', pageEntries);

async function inspect(handles: {
	documents: {
		list(): Promise<
			(
				| { data: { path: string }; error: null }
				| { error: { path: string; name: string } }
			)[]
		>;
	};
	folders: Pick<typeof folders, 'list' | 'at'>;
}) {
	const listed = await handles.folders.list();
	const names = listed.data;
	const rows = await handles.documents.list();
	const documents = rows.map((r) =>
		r.error
			? { path: r.error.path, state: r.error.name }
			: { path: r.data.path, state: 'valid' },
	);
	const folders = await Promise.all(
		names.map(async (name) => {
			const r = await handles.folders.at(name).article.get();
			return {
				name,
				article: r.error
					? r.error.name
					: r.data === undefined
						? 'absent'
						: 'valid',
			};
		}),
	);
	return Ok({ documents, folders });
}

function inspection(read: () => ReturnType<typeof inspect>) {
	return defineAction({
		description: 'Inspect page entries',
		input: {},
		annotations: { readOnlyHint: true },
		run: read,
	});
}
export const entriesActions = {
	separate: inspection(() => inspect({ documents, folders })),
	grouped: inspection(() => inspect(pages)),
	directory: inspection(() => inspect(directory)),
	archive: inspection(() => inspect(archive)),
	shelf: defineAction({
		description: 'Inspect one shelf',
		input: { shelf: field.text() },
		annotations: { readOnlyHint: true },
		run: ({ shelf }) => inspect(shelves.at(shelf)),
	}),
	edit: defineAction({
		description: 'Correct a direct document in the archive',
		input: { name: field.text(), old: field.text(), new: field.text() },
		run: ({ name, old, new: replacement }) =>
			archive.documents.at(name).set({ old, new: replacement }),
	}),
};
