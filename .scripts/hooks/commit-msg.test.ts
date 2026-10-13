/**
 * @file The commit-msg hook's rules: which subjects may be committed.
 * `npm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAcceptable, subjectOf } from './commit-msg';

test('the subject is the first line that is neither blank nor a git comment', () => {
    assert.equal(subjectOf('\n# Please enter the commit message\n\nfeat: x\n\nbody'), 'feat: x');
    assert.equal(subjectOf('# only comments\n\n'), '');
});

test('Conventional Commits are accepted', () => {
    for (const subject of ['feat: x', 'fix(popover): x', 'feat!: x', 'chore(release): 0.1.0', 'docs: x']) {
        assert.ok(isAcceptable(subject), subject);
    }
});

test("git's own messages are accepted", () => {
    for (const subject of ['Merge branch main', 'Revert "feat: x"', 'fixup! feat: x', 'squash! x', 'amend! x']) {
        assert.ok(isAcceptable(subject), subject);
    }
});

test('anything else is rejected', () => {
    for (const subject of ['Update README', 'feat:x', 'feature: x', 'Feat: x', '']) {
        assert.ok(!isAcceptable(subject), subject);
    }
});
