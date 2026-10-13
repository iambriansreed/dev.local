/**
 * @file What decides whether a push to main ships a release, and which changelog text
 * becomes its GitHub release notes. `npm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RELEASABLE, changelogSection } from './release';

test('feat, fix, perf and breaking changes release', () => {
    for (const log of [
        'feat: search accounts',
        'fix(popover): close on a Space change',
        'perf: cache decoded favicons',
        'refactor!: drop the v0 store',
        'feat(store)!: new accounts.enc format',
        // One subject among several in `git log`, and footers on their own lines
        'docs: readme\n\nfix: a real bug',
        'chore: tidy\n\nBREAKING CHANGE: the store moved',
        'chore: tidy\n\nBREAKING-CHANGE: the store moved',
    ]) {
        assert.ok(RELEASABLE.test(log), log);
    }
});

test('everything else releases nothing', () => {
    for (const log of [
        'docs: readme',
        'chore(release): 0.1.0',
        'ci: pin actions',
        'build(deps): bump skrapa',
        'feature: not a type',
        'feat:no space',
        'fixup! feat: squashed away',
        'Merge branch main',
    ]) {
        assert.ok(!RELEASABLE.test(log), log);
    }
});

const CHANGELOG = `# Changelog

## [0.2.0](https://github.com/x/y/compare/v0.1.1...v0.2.0) (2026-10-01)

### Features

* export accounts

### [0.1.1](https://github.com/x/y/compare/v0.1.0...v0.1.1) (2026-09-25)

### Bug Fixes

* a fix

## 0.1.0 (2026-09-20)

* first release
`;

test('a section runs from its heading to the next version, heading left out', () => {
    assert.equal(changelogSection(CHANGELOG, '0.2.0'), '\n### Features\n\n* export accounts\n');
});

test('patch sections (### headings) and first releases (no link) are found too', () => {
    assert.equal(changelogSection(CHANGELOG, '0.1.1'), '\n### Bug Fixes\n\n* a fix\n');
    assert.equal(changelogSection(CHANGELOG, '0.1.0'), '\n* first release\n');
});

test('a version with no section gives nothing, not its neighbour', () => {
    assert.equal(changelogSection(CHANGELOG, '0.3.0'), '');
    // A prefix of a real version isn't that version
    assert.equal(changelogSection(CHANGELOG, '0.1'), '');
});
