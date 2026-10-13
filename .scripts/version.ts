#!/usr/bin/env -S npx --no tsx
/**
 * @file Prints, sets and verifies the app's version.
 *
 * The version is set in **one** place: `CFBundleShortVersionString` in
 * `app/Resources/Info.plist`. The app (its About panel and the Settings footer), the
 * `.dmg` name and the release tag all read it from there.
 *
 * Two generated copies follow it, because neither consumer can read a plist:
 *
 * | File | Why it exists |
 * | --- | --- |
 * | `package.json` | this repository's npm package; `npm version` keeps the lockfile with it |
 * | `web/version.json` | the website imports it to show the version on the download button |
 *
 * `web/version.json` is a separate file rather than the root `package.json` because
 * Skrapa compiles pages with `--rootDir` at `web/`, so a page cannot import anything
 * above that directory.
 *
 * Releases bump all of them from the commit messages (`.scripts/release.ts`); setting a
 * version here is for the rare time that is wanted by hand. Every writer writes every
 * copy, and CI runs `--check` before it releases or deploys, so a hand edit that missed
 * one fails loudly instead of shipping a wrong number.
 *
 * ```sh
 * .scripts/version.ts            # print the version
 * .scripts/version.ts 0.2.0      # set it everywhere (plus package-lock.json)
 * .scripts/version.ts --check    # exit 1 if a copy disagrees with Info.plist
 * ```
 *
 * @module version
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readVersion, writeVersion } from './plist-version';

/** Every path here is relative to the repository root, so work from there. */
process.chdir(path.join(import.meta.dirname, '..'));

/**
 * The single source of truth for the version.
 */
const PLIST = 'app/Resources/Info.plist';

/**
 * The generated copies that `--check` compares against {@link PLIST}.
 *
 * `package-lock.json` is deliberately absent: `npm version` and commit-and-tag-version
 * both keep it in step with `package.json` on their own, so checking it would only ever
 * report a problem npm had already made impossible.
 */
const COPIES: readonly string[] = ['package.json', 'web/version.json'];

/** A complete `major.minor.patch`, and nothing looser: no ranges, tags or `v` prefix. */
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Reads the version from the plist.
 *
 * @returns e.g. `"0.1.0"`.
 */
function plistVersion(): string {
    return readVersion(fs.readFileSync(PLIST, 'utf8'));
}

/**
 * Reads the `version` field from a JSON file.
 *
 * @param file Path to a JSON file, relative to the repository root.
 * @returns The version, or `""` when the file has no `version` field.
 */
function jsonVersion(file: string): string {
    const data: { version?: string } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data.version ?? '';
}

/**
 * Rewrites a JSON file's `version` in place, leaving every other key untouched and in
 * its original order. That is what keeps the explanatory `_comment` at the top of
 * `web/version.json` alive across a bump.
 *
 * @param file Path to a JSON file, relative to the repository root.
 * @param version The version to write.
 */
function writeJsonVersion(file: string, version: string): void {
    const data: Record<string, unknown> = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.version = version;
    fs.writeFileSync(file, `${JSON.stringify(data, null, 4)}\n`);
}

/**
 * Compares every generated copy with the plist.
 *
 * @returns The agreed version, for a caller that wants to print it.
 * @throws {Error} With a message naming the first file that disagrees.
 */
function check(): string {
    const expected = plistVersion();
    for (const copy of COPIES) {
        const found = jsonVersion(copy);
        if (found !== expected) {
            throw new Error(
                `version mismatch: ${PLIST} says ${expected}, ${copy} says ${found || 'nothing'}.\n` +
                    `Run .scripts/version.ts ${expected} to sync them.`
            );
        }
    }
    return expected;
}

/**
 * Writes `version` to the plist and to every generated copy, then verifies the result.
 *
 * `npm version` is used for `package.json` rather than a hand-rolled rewrite because it
 * preserves the file's formatting and updates `package-lock.json` in the same step.
 *
 * @param version A `major.minor.patch` version.
 */
function set(version: string): void {
    fs.writeFileSync(PLIST, writeVersion(fs.readFileSync(PLIST, 'utf8'), version));
    execFileSync('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], {
        stdio: 'ignore',
    });
    writeJsonVersion('web/version.json', version);
    check();
}

/**
 * @param argv Arguments after the script name.
 * @returns A process exit code.
 */
function main(argv: string[]): number {
    const [command] = argv;
    try {
        if (command === undefined) {
            console.log(plistVersion());
            return 0;
        }
        if (command === '--check') {
            console.log(check());
            return 0;
        }
        if (!SEMVER.test(command)) {
            const what = command.startsWith('-')
                ? 'unknown option'
                : 'not a major.minor.patch version';
            console.error(`${what}: ${command}`);
            console.error(`usage: ${process.argv[1]} [<major.minor.patch> | --check]`);
            return 2;
        }
        set(command);
        console.log(command);
        return 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    }
}

process.exit(main(process.argv.slice(2)));
