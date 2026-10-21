import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import type { FileContent } from './merge.js';

const ownContent = (content: FileContent | null): FileContent | null =>
	content instanceof Uint8Array ? content.slice() : content;

export const ReadError = defineErrors({
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Repository read failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type ReadError = InferErrors<typeof ReadError>;

export const SaveError = defineErrors({
	InvalidId: ({ id }: { id: string }) => ({
		message: `Row id must be one filename segment: ${id}`,
		id,
	}),
	InvalidPath: ({ path }: { path: string }) => ({
		message: `Invalid repository path: ${path}`,
		path,
	}),
	CaseTwin: ({ path, existing }: { path: string; existing: string }) => ({
		message: `Path ${path} differs from ${existing} only by case`,
		path,
		existing,
	}),
	Occupied: ({
		path,
		existing,
		kind,
	}: {
		path: string;
		existing: string;
		kind: 'file' | 'directory';
	}) => ({
		message: `Cannot save ${path}: ${existing} is a ${kind}`,
		path,
		existing,
		kind,
	}),
	NotText: () => ({
		message: 'Repository writes require UTF-8 text without NUL bytes',
	}),
	Unparseable: ({ reason }: { reason: string }) => ({
		message: `Row fields cannot be saved: ${reason}`,
		reason,
	}),
	Conflict: ({ path, base, current }: {
		path: string;
		base: FileContent | null;
		current: FileContent | null;
	}) => ({
		message: `The file changed while ${path} was edited`,
		path,
		base: ownContent(base),
		current: ownContent(current),
	}),
	StorageFailed: ({ cause }: { cause: unknown }) => ({
		message: `Repository save failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type SaveError = InferErrors<typeof SaveError>;
