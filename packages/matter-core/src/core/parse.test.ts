import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';

describe('parseMarkdown', () => {
	test('splits frontmatter from body', () => {
		const { data, error } = parseMarkdown(
			'---\ntitle: Hello\nstatus: draft\n---\n# Body\n\ntext',
		);
		expect(error).toBeNull();
		expect(data).toEqual({
			frontmatter: { title: 'Hello', status: 'draft' },
			body: '# Body\n\ntext',
		});
	});

	test('no frontmatter is an empty mapping and the whole file is body', () => {
		const { data, error } = parseMarkdown(
			'# Just a heading\n\nno frontmatter here',
		);
		expect(error).toBeNull();
		expect(data).toEqual({
			frontmatter: {},
			body: '# Just a heading\n\nno frontmatter here',
		});
	});

	test('empty frontmatter block parses to an empty mapping', () => {
		const { data, error } = parseMarkdown('---\n---\nbody');
		expect(error).toBeNull();
		expect(data).toEqual({ frontmatter: {}, body: 'body' });
	});

	test('YAML 1.2: "NO" stays a string (no Norway-problem coercion)', () => {
		const { data } = parseMarkdown('---\ncountry: NO\n---\nbody');
		expect(data?.frontmatter).toEqual({ country: 'NO' });
	});

	test('conflict markers are unreadable, never silently parsed', () => {
		const raw =
			'---\ntitle: x\n<<<<<<< HEAD\nstatus: a\n=======\nstatus: b\n>>>>>>> other\n---\nbody';
		expect(parseMarkdown(raw).error?.name).toBe('ConflictMarkers');
	});

	test('conflict-marker examples in the opaque body stay readable and verbatim', () => {
		const body =
			'```txt\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n```';
		const raw = `---\ntitle: How conflicts work\n---\n${body}`;
		const { data, error } = parseMarkdown(raw);

		expect(error).toBeNull();
		expect(data).toEqual({
			frontmatter: { title: 'How conflicts work' },
			body,
		});
	});

	test('a body-only conflict-marker example is opaque text', () => {
		const raw = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> other\n';
		expect(parseMarkdown(raw).data).toEqual({ frontmatter: {}, body: raw });
	});

	test('malformed YAML is unreadable (and carries the parser error as cause)', () => {
		const raw = '---\n: : :\n  bad\n indent\n---\nbody';
		const { error } = parseMarkdown(raw);
		expect(error?.name).toBe('InvalidYaml');
		// The parser error is now carried as `cause` (previously swallowed).
		if (error?.name === 'InvalidYaml') expect(error.cause).toBeDefined();
	});

	test('frontmatter that is not a mapping (a list) is unreadable', () => {
		const raw = '---\n- a\n- b\n---\nbody';
		expect(parseMarkdown(raw).error?.name).toBe('FrontmatterNotMapping');
	});
});

test('an opening fence requires an exact closing fence line', () => {
	expect(parseMarkdown('---\ntitle: x\n---not-a-fence\nbody').error?.name).toBe(
		'InvalidYaml',
	);
	expect(parseMarkdown('---\ntitle: x').error?.name).toBe('InvalidYaml');
	expect(parseMarkdown('---\ntitle: x\n---').data).toEqual({
		frontmatter: { title: 'x' },
		body: '',
	});
	const body = '# Body\n---\nexample: content\n---\n';
	expect(parseMarkdown(body).data).toEqual({ frontmatter: {}, body });
});

test('extra YAML documents and content after document end refuse', () => {
	for (const raw of [
		'---\ntitle: x\n...\nother: y\n---\n',
		'---\ntitle: x\n--- second\nother: y\n---\n',
	]) {
		expect(parseMarkdown(raw).error?.name).toBe('InvalidYaml');
	}
});
test('only an empty YAML document is an empty mapping, never an explicit null scalar', () => {
	for (const yaml of ['null', '~', '!!null null']) {
		expect(parseMarkdown(`---\n${yaml}\n---\n`).error?.name).toBe(
			'FrontmatterNotMapping',
		);
	}
	for (const yaml of ['', '# comment only', '{}']) {
		expect(parseMarkdown(`---\n${yaml}\n---\n`).data?.frontmatter).toEqual({});
	}
});
