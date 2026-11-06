import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type AppEnvironment,
	AppNameError,
	type AppNameErrorKind,
	appDataIdentifier,
	hostFromIdentifier,
	hostFromSiteUrl,
	relativeFolderPath,
} from './app-names.js';

const rules = JSON.parse(
	readFileSync(join(import.meta.dir, '../../fixtures/app-names.json'), 'utf8'),
) as {
	cases: {
		identifier: string;
		environment: AppEnvironment;
		host: string;
		folder: string;
		appData: string;
	}[];
	refused: {
		identifier: string;
		environment: AppEnvironment;
		error: AppNameErrorKind;
	}[];
};

test.each(rules.cases)('names $identifier', (entry) => {
	expect(hostFromIdentifier(entry.identifier, entry.environment)).toBe(
		entry.host,
	);
	expect(hostFromSiteUrl(`https://${entry.host}`)).toBe(entry.host);
	expect(relativeFolderPath(entry.host)).toBe(entry.folder);
	expect(appDataIdentifier(entry.host, entry.environment)).toBe(entry.appData);
});

test.each(rules.refused)('refuses $identifier', (entry) => {
	try {
		const host = hostFromIdentifier(entry.identifier, entry.environment);
		relativeFolderPath(host);
		throw new Error('accepted');
	} catch (error) {
		expect(error).toBeInstanceOf(AppNameError);
		expect((error as AppNameError).kind).toBe(entry.error);
	}
});

test.each([
	'http://notes.example.com',
	'https://notes.example.com/path',
	'https://notes.example.com:8443',
])('refuses site %s', (site) => {
	expect(() => hostFromSiteUrl(site)).toThrow(AppNameError);
});
