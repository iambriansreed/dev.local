#!/usr/bin/env node
/**
 * @file Reads and writes `CFBundleShortVersionString` in an Info.plist.
 *
 * This is the one place that knows how to edit that key, because it is needed from two
 * directions: `.scripts/release.config.json` hands it to commit-and-tag-version as an
 * "updater" during a release, and `.scripts/version.ts` calls it when a version is set
 * by hand. Keeping it here means the substitution is written once and the two paths
 * cannot drift apart.
 *
 * It is a text substitution rather than a plist parser (or PlistBuddy, which rewrites
 * the whole file with its own indentation), so a version bump stays a one-line diff.
 *
 * As a command:
 * ```sh
 * .scripts/plist-version.ts app/Resources/Info.plist          # print the version
 * .scripts/plist-version.ts app/Resources/Info.plist 0.2.0    # set it
 * ```
 *
 * @module plist-version
 */

import fs from 'node:fs';

/**
 * Captures the one key we care about in three parts: everything up to and including the
 * opening `<string>`, the version itself, and the closing `</string>`. The value is
 * matched as "anything but `<`" so a malformed file can never swallow the rest of it.
 *
 * Global, so `writeVersion` sees every occurrence and can refuse a plist with more
 * than one; without the flag `replace` stops after the first and the duplicate-key
 * check below could never fail. Both users below are stateless despite the `lastIndex`
 * a global regex carries: `matchAll` works on a clone of it, and `replace` resets it.
 * `exec` would not be, so nothing here calls it.
 */
const VERSION_KEY = /(<key>CFBundleShortVersionString<\/key>\s*<string>)([^<]*)(<\/string>)/g;

/**
 * Pulls the version out of a plist's text.
 *
 * Named `readVersion` because that is the method name commit-and-tag-version calls on a
 * custom updater; see https://github.com/absolute-version/commit-and-tag-version.
 *
 * @param contents Entire contents of an Info.plist.
 * @returns The version, e.g. `"0.1.0"`.
 * @throws {Error} If the file has no `CFBundleShortVersionString` key.
 */
export function readVersion(contents: string): string {
    const [match] = contents.matchAll(VERSION_KEY);
    if (!match) throw new Error('no CFBundleShortVersionString in it');
    return match[2];
}

/**
 * Returns the plist's text with a new version substituted in.
 *
 * The replacement is a function rather than the string `'$1' + version`: `"$1"` followed
 * by `"0.2.0"` reads as the capture group `$10`, which does not exist, so that form
 * silently produces the wrong output.
 *
 * Refusing to write when the key appears any number of times other than once is
 * deliberate: a plist with two of them is malformed, and guessing which to edit would
 * ship a build whose version is not the one that was released.
 *
 * @param contents Entire contents of an Info.plist.
 * @param version The version to write, e.g. `"0.2.0"`.
 * @returns The updated contents, byte-identical apart from the version.
 * @throws {Error} If the key is missing or appears more than once.
 */
export function writeVersion(contents: string, version: string): string {
    let found = 0;
    const updated = contents.replace(VERSION_KEY, (_match: string, open: string, _old: string, close: string) => {
        found += 1;
        return `${open}${version}${close}`;
    });
    if (found !== 1) throw new Error(`expected one CFBundleShortVersionString, found ${found}`);
    return updated;
}

// Run directly (rather than imported): behave as the CLI described above.
if (import.meta.main) {
    const [file, version] = process.argv.slice(2);
    if (!file) {
        console.error(`usage: ${process.argv[1]} <plist> [<version>]`);
        process.exit(2);
    }
    try {
        const contents = fs.readFileSync(file, 'utf8');
        if (version === undefined) {
            console.log(readVersion(contents));
        } else {
            fs.writeFileSync(file, writeVersion(contents, version));
        }
    } catch (error) {
        console.error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}
