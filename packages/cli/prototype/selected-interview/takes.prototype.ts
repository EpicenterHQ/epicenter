// Compare an upload bucket with an explicitly named member of the same folder.
// This disk experiment has one writer; existence checks and writes are separate.
import {
	defineAction,
	field,
	folder,
	Ok,
	type UploadedFile,
} from '@epicenter/app';
import { defineDirectory, fileSlot } from './directory.prototype';

function memberName(name: string) {
	if (
		!name ||
		name === '.' ||
		name === '..' ||
		/[/\\\x00-\x1f]/.test(name) ||
		name.toLowerCase().startsWith('.git')
	)
		throw new Error('Expected one filename');
	return name;
}

function selected<T>(bind: (dir: string) => T) {
	return () => ({
		select: (_keys: unknown, dir: string) => bind(dir),
	});
}

function exact(name: string) {
	return selected((dir) => fileSlot(dir + '/' + memberName(name)));
}

function recordings(dir: string) {
	const at = (name: string) => fileSlot(dir + '/' + memberName(name));
	const list = async () =>
		(await folder.list(dir))
			.map((path) => path.slice(dir.length + 1))
			.filter((name) => !name.includes('/'));
	return { at, list };
}

function wildcard(prefix: string) {
	return selected((dir) => {
		const members = recordings(dir + '/' + prefix);
		return {
			list: members.list,
			add: (upload: UploadedFile) => members.at(upload.name).add(upload),
			at: members.at,
		};
	});
}
function keyed(prefix: string) {
	return selected((dir) => {
		const members = recordings(dir + '/' + prefix);
		return {
			list: members.list,
			at: ({ name }: { name: string }) => members.at(name),
		};
	});
}

// Two precise candidate grammars; this deliberately implements only the trial forms.
function file(path: 'recordings/*'): ReturnType<typeof wildcard>;
function file(path: 'recordings/{name}'): ReturnType<typeof keyed>;
function file(path: 'consent.pdf'): ReturnType<typeof exact>;
function file(path: string) {
	if (path === 'recordings/*') return wildcard('recordings');
	if (path === 'recordings/{name}') return keyed('recordings');
	if (path === 'consent.pdf') return exact(path);
	throw new Error('Unsupported trial path');
}
const buckets = defineDirectory('data/buckets/{interview}', {
	consent: file('consent.pdf'),
	recordings: file('recordings/*'),
});
const named = defineDirectory('data/named/{interview}', {
	consent: file('consent.pdf'),
	recordings: file('recordings/{name}'),
});

const interview = field.text(),
	name = field.text(),
	audio = field.file({ accept: ['audio/*'] });
function consentActions(
	group: Pick<typeof buckets, 'at'> | Pick<typeof named, 'at'>,
) {
	return {
		exists: defineAction({
			description: 'Check for consent',
			annotations: { readOnlyHint: true },
			input: { interview },
			run: async (key) => Ok(await group.at(key.interview).consent.exists()),
		}),
		sign: defineAction({
			description: 'Save consent',
			input: { interview, pdf: field.file({ accept: ['application/pdf'] }) },
			run: ({ interview, pdf }) => group.at(interview).consent.add(pdf),
		}),
		list: defineAction({
			description: 'List takes',
			input: { interview },
			run: async (key) => Ok(await group.at(key.interview).recordings.list()),
		}),
	};
}
export const takes = {
	bucket: {
		...consentActions(buckets),
		add: defineAction({
			description: 'Add under the uploaded filename',
			input: { interview, audio },
			run: ({ interview, audio }) =>
				buckets.at(interview).recordings.add(audio),
		}),
		saveas: defineAction({
			description: 'Add under a chosen filename',
			input: { interview, name, audio },
			run: ({ interview, name, audio }) =>
				buckets.at(interview).recordings.at(name).add(audio),
		}),
		replace: defineAction({
			description: 'Replace the named take',
			input: { interview, name, audio },
			run: ({ interview, name, audio }) =>
				buckets.at(interview).recordings.at(name).replace(audio),
		}),
	},
	named: {
		...consentActions(named),
		add: defineAction({
			description: 'Add at the chosen name',
			input: { interview, name, audio },
			run: ({ interview, name, audio }) =>
				named.at(interview).recordings.at({ name }).add(audio),
		}),
		replace: defineAction({
			description: 'Replace the selected take',
			input: { interview, name, audio },
			run: ({ interview, name, audio }) =>
				named.at(interview).recordings.at({ name }).replace(audio),
		}),
	},
};
