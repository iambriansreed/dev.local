#!/usr/bin/env node
/**
 * @file Cuts a release from the Conventional Commits since the last tag.
 *
 * Wraps commit-and-tag-version (the tool Skrapa uses) so that there is one definition of
 * what a release is, shared by CI and by a release cut from a laptop. It works out the
 * bump, writes it to every version file (see `.scripts/release.config.json`), adds the
 * section to `CHANGELOG.md`, commits `chore(release): x.y.z` and tags `v<x.y.z>`.
 *
 * It commits and tags **locally and never pushes**. CI runs this same script on every
 * push to `main` (`.github/workflows/release.yml`); one cut by hand is published once
 * pushed with `git push --follow-tags origin main`.
 *
 * ```sh
 * .scripts/release.ts                      # cut a release, if the commits call for one
 * .scripts/release.ts --dry-run            # show what it would do
 * .scripts/release.ts --release-as 1.0.0   # choose the version (any tool flag passes through)
 * .scripts/release.ts --notes 0.2.0        # print that version's CHANGELOG.md section
 * ```
 *
 * Below 1.0.0 a breaking change bumps the minor version and a feat or fix the patch,
 * which is commit-and-tag-version's `preMajor` behaviour.
 *
 * @module release
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * The locally installed tool, never `npx --yes`: this runs in a job holding a token that
 * can push to `main`, and it builds the app people keep their 2FA secrets in, so the
 * ~160 packages it pulls in are the ones `package-lock.json` pins rather than whatever
 * the registry resolves today.
 */
const TOOL: string = 'node_modules/.bin/commit-and-tag-version';

/**
 * Config for {@link TOOL}: plain JSON, with the one piece that has to be code (the
 * Info.plist updater) named in it as a module path that the tool `require()`s.
 */
const CONFIG: string = '.scripts/release.config.json';

/**
 * Matches a commit subject (or a `BREAKING CHANGE:` footer) that should produce a
 * release. Three alternatives:
 *
 * 1. `feat:`, `fix:` or `perf:`, with an optional scope.
 * 2. Any type at all followed by `!`, which marks a breaking change (`refactor!:`).
 * 3. A `BREAKING CHANGE:` footer on its own line, whatever the subject said.
 *
 * Deciding this here rather than leaving it to the tool's own
 * `--noBumpWhenEmptyChanges` is deliberate: that flag counts only feat, fix and
 * breaking changes, so a release containing nothing but `perf` commits would never
 * ship.
 */
export const RELEASABLE: RegExp =
    /^(?:(?:feat|fix|perf)(?:\([^()]+\))?!?: |[a-z]+(?:\([^()]+\))?!: |BREAKING[ -]CHANGE: )/m;

/**
 * Runs a git command and returns its trimmed stdout.
 *
 * git's own stderr is discarded because the failures here are expected answers, not
 * problems: `git describe` on a repository with no tags prints "fatal: No names found",
 * which in a CI log reads like something went wrong when it only means "first release".
 *
 * @param args Arguments to `git`.
 * @returns stdout with surrounding whitespace removed, or `""` if git failed
 *   (an unborn branch, no tags yet, and other "nothing to report" cases).
 */
function git(...args: string[]): string {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return '';
    }
}

/**
 * One version's section of a changelog, for use as GitHub release notes.
 *
 * Runs from the version's own heading to the next version's, leaving the heading itself
 * out because a GitHub release already has a title. Headings look like
 * `## [0.2.0](compare-link) (date)` (`###` for a patch), or `## 0.1.0 (date)` for a first
 * release, which is why the version is unwrapped from any `[...]` around it.
 *
 * @param changelog The whole of `CHANGELOG.md`.
 * @param version The version whose section to return, without a `v`.
 * @returns The section, or `""` when the version has none.
 */
export function changelogSection(changelog: string, version: string): string {
    const collected: string[] = [];
    let printing = false;
    for (const line of changelog.split('\n')) {
        const heading = /^###? \[?([0-9][^\]\s]*)/.exec(line);
        if (heading) {
            if (printing) break;
            if (heading[1] === version) {
                printing = true;
                continue;
            }
        }
        if (printing) collected.push(line);
    }
    return collected.join('\n');
}

/**
 * Prints one version's section of `CHANGELOG.md` ({@link changelogSection}).
 *
 * @param version The version whose section to print, without a `v`.
 * @returns A process exit code.
 */
function notes(version: string | undefined): number {
    if (!version) {
        console.error(`usage: ${process.argv[1]} --notes <version>`);
        return 2;
    }
    if (!fs.existsSync('CHANGELOG.md')) {
        console.error('CHANGELOG.md does not exist yet; the first release creates it.');
        return 1;
    }
    console.log(changelogSection(fs.readFileSync('CHANGELOG.md', 'utf8'), version));
    return 0;
}

/** What {@link plan} decided. */
type Plan = {
    /** Whether to run the tool at all. */
    release: boolean;
    /** Why not, when `release` is false; printed as-is. */
    reason?: string;
    /** Extra arguments for the tool. */
    extra: string[];
};

/**
 * Decides whether there is anything to release, and with which extra flags.
 *
 * @param decideForUs Whether to skip a run that the commits do not call for.
 *   False when the caller passed arguments of their own (`--release-as`, `--dry-run`):
 *   asking for a release by hand is reason enough. The other two answers here are not
 *   optional and apply either way, since `--first-release` changes what version comes
 *   out and an already-tagged HEAD has nothing left to cut.
 */
function plan(decideForUs: boolean): Plan {
    const tagged = git('tag', '--points-at', 'HEAD')
        .split('\n')
        .find((tag) => tag.startsWith('v'));
    if (tagged) {
        // A re-run, or a release commit that was cut on a laptop and only needs pushing
        return { release: false, reason: `HEAD is already tagged ${tagged}; nothing to cut.`, extra: [] };
    }

    const last = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
    if (!last) {
        // With no tag to measure from, the tool would bump past the version the plist
        // already has. --first-release tags that version as it stands and starts the
        // changelog from it.
        return { release: true, extra: ['--first-release'] };
    }

    const log = git('log', '--format=%s%n%b', `${last}..HEAD`);
    if (decideForUs && !RELEASABLE.test(log)) {
        return {
            release: false,
            reason: `No feat, fix, perf or breaking change since ${last}; nothing to release.`,
            extra: [],
        };
    }
    return { release: true, extra: [] };
}

/**
 * @param argv Arguments after the script name.
 * @returns A process exit code.
 */
function main(argv: string[]): number {
    if (argv[0] === '--notes') return notes(argv[1]);

    const { release, reason, extra } = plan(argv.length === 0);
    if (!release) {
        console.log(reason);
        return 0;
    }

    if (!fs.existsSync(TOOL)) {
        console.error(`${TOOL} is missing. Run npm install (or npm ci) first.`);
        return 1;
    }

    const result = spawnSync(TOOL, ['--config', CONFIG, ...extra, ...argv], { stdio: 'inherit' });
    if (result.error) {
        console.error(result.error.message);
        return 1;
    }
    return result.status ?? 1;
}

// Run directly (rather than imported by its tests): behave as the CLI described above,
// from the repository root, which every path here is relative to
if (import.meta.main) {
    process.chdir(path.join(import.meta.dirname, '..'));
    process.exit(main(process.argv.slice(2)));
}
