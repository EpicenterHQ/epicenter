import { basename, dirname } from 'node:path/posix';

export type MediaCandidate = {
	archivePath: string;
	fileName: string;
};

export type SidecarCandidate = {
	archivePath: string;
	fileName: string;
	claimedTitle: string | null;
};

export type SidecarMatch = {
	mediaPath: string;
	sidecarPath: string;
};

export type UnmatchedSidecar = {
	sidecarPath: string;
	reason: 'no_candidate' | 'ambiguous' | 'media_already_matched';
};

function sidecarStem(fileName: string): string {
	const supplemental = fileName.replace(/\.supplement[^/]*\.json$/i, '');
	if (supplemental !== fileName) return supplemental;
	return fileName.replace(/\.json$/i, '');
}

function googleDuplicateVariant(name: string): string | null {
	const match = /^(.*)(\.[^.]+)\((\d+)\)$/.exec(name);
	if (!match) return null;
	return `${match[1]}(${match[3]})${match[2]}`;
}

function score(sidecar: SidecarCandidate, media: MediaCandidate): number {
	if (dirname(sidecar.archivePath) !== dirname(media.archivePath)) return 0;
	const mediaName = media.fileName.toLowerCase();
	const title = sidecar.claimedTitle
		? basename(sidecar.claimedTitle).toLowerCase()
		: null;
	if (title === mediaName) return 10_000;

	const stem = sidecarStem(sidecar.fileName).toLowerCase();
	if (stem === mediaName) return 9_000;
	if (googleDuplicateVariant(stem) === mediaName) return 8_000;

	// Current Takeout sidecar names are sometimes clipped before the
	// `.supplemental-metadata.json` suffix. A reasonably long prefix is useful;
	// a short prefix such as IMG is too ambiguous to trust.
	if (stem.length >= 8 && mediaName.startsWith(stem))
		return 1_000 + stem.length;
	return 0;
}

/** Match at most one sidecar to one media file, refusing ties instead of guessing. */
export function matchSidecars({
	media,
	sidecars,
}: {
	media: MediaCandidate[];
	sidecars: SidecarCandidate[];
}): { matches: SidecarMatch[]; unmatched: UnmatchedSidecar[] } {
	const proposals = sidecars.map((sidecar) => {
		const ranked = media
			.map((candidate) => ({ candidate, score: score(sidecar, candidate) }))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score);
		const topScore = ranked[0]?.score ?? 0;
		const top = ranked.filter((entry) => entry.score === topScore);
		return { sidecar, topScore, top };
	});
	proposals.sort((a, b) => b.topScore - a.topScore);

	const usedMedia = new Set<string>();
	const matches: SidecarMatch[] = [];
	const unmatched: UnmatchedSidecar[] = [];
	for (const proposal of proposals) {
		if (proposal.top.length === 0) {
			unmatched.push({
				sidecarPath: proposal.sidecar.archivePath,
				reason: 'no_candidate',
			});
			continue;
		}
		if (proposal.top.length > 1) {
			unmatched.push({
				sidecarPath: proposal.sidecar.archivePath,
				reason: 'ambiguous',
			});
			continue;
		}

		const mediaPath = proposal.top[0]?.candidate.archivePath;
		if (!mediaPath || usedMedia.has(mediaPath)) {
			unmatched.push({
				sidecarPath: proposal.sidecar.archivePath,
				reason: 'media_already_matched',
			});
			continue;
		}
		usedMedia.add(mediaPath);
		matches.push({
			mediaPath,
			sidecarPath: proposal.sidecar.archivePath,
		});
	}

	return { matches, unmatched };
}
