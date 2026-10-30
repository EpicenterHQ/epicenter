/**
 * Git LFS pointers: how every non-note file in a data folder reads in Git
 * (decision 40). A conflict copy of a binary file is named from the losing
 * pointer's oid (`conflictSibling` in `settle.ts`).
 *
 * Ported from `claude/repository-v2` `core/markdown.ts` at `c32dd466`.
 */

export type LfsPointer = { oid: string; size: number };

const POINTER =
	/^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (\d+)\n$/;

/** The pointer a file's text holds, or null when the text is not a pointer. */
export function parsePointer(text: string): LfsPointer | null {
	const found = POINTER.exec(text);
	if (found === null) return null;
	const [, oid = '', size = ''] = found;
	return { oid, size: Number(size) };
}

export function writePointer({ oid, size }: LfsPointer): string {
	return `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;
}
