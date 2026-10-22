/**
 * Release boundaries prevent a monorepo's unrelated tags, mixed source commits,
 * incomplete architecture matrices, and late older builds from changing Epicenter's feed.
 */
import { expect, test } from 'bun:test';
import {
	collect,
	type ReleasePart,
	releaseVersion,
	requireNewer,
} from './release.js';

function part(target: string): ReleasePart {
	return {
		rehearsal: false,
		product: 'epicenter',
		tag: 'epicenter-v0.0.2',
		version: '0.0.2',
		commit: 'a'.repeat(40),
		target,
		archive: `Epicenter_0.0.2_${target}.app.tar.gz`,
		signature: 'signed-artifact',
		dmg: `Epicenter_0.0.2_${target}.dmg`,
	};
}
const targets = ['darwin-aarch64', 'darwin-x86_64'] as const;

test('only product-specific stable release tags identify an Epicenter version', () => {
	expect(releaseVersion('epicenter-v0.0.2')).toBe('0.0.2');
	for (const tag of [
		'v0.0.2',
		'todos-v0.0.2',
		'epicenter-v0.0.2-beta.1',
		'epicenter-v00.0.2',
	]) {
		expect(() => releaseVersion(tag)).toThrow();
	}
});

test('all targets share a version and exact tag download URLs', () => {
	const manifest = collect(targets.map(part), 'epicenter-v0.0.2', targets);
	expect(Object.keys(manifest.platforms)).toEqual([...targets]);
	expect(manifest.platforms['darwin-aarch64']?.url).toBe(
		'https://github.com/EpicenterHQ/epicenter/releases/download/epicenter-v0.0.2/Epicenter_0.0.2_darwin-aarch64.app.tar.gz',
	);
});

test('missing, duplicate, or mixed source builds never assemble a feed', () => {
	const arm = part(targets[0]);
	const intel = part(targets[1]);
	for (const parts of [
		[arm],
		[arm, arm],
		[arm, { ...intel, commit: 'b'.repeat(40) }],
		[arm, { ...intel, version: '0.0.1' }],
		[arm, { ...intel, signature: '' }],
		[arm, { ...intel, rehearsal: true }],
		[arm, { ...intel, dmg: null }],
	]) {
		expect(() => collect(parts, 'epicenter-v0.0.2', targets)).toThrow();
	}
});

test('an older build finishing late or a retry cannot move the feed backward', () => {
	expect(() => requireNewer('0.0.2', '0.0.4')).toThrow();
	expect(() => requireNewer('0.0.4', '0.0.4')).toThrow();
	expect(() => requireNewer('0.1.0', '0.0.9')).not.toThrow();
});
