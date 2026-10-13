// procs.ts - the .command script Terminal runs and the log rotation rule.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { commandScript, LOG_MAX_BYTES, shouldRotate } from './procs.ts';

describe('server/src/server/procs.ts - commandScript', () => {
    // Terminal runs this file directly, so it has to be a shell script it can execute.
    test('is a /bin/sh script that sets the window title and then follows the log', () => {
        const text = commandScript('/Users/me/.dev.localhost/logs/apps/demo.log', 'demo');
        assert.ok(text.startsWith('#!/bin/sh\n'));
        assert.match(text, /printf '\\033\]0;%s\\007' 'demo\.log'/);
        assert.match(text, /exec tail -n 500 -F '\/Users\/me\/\.dev\.localhost\/logs\/apps\/demo\.log'\n$/);
    });

    // The path is user-owned data in a shell line, so a quote in it must not end the string.
    test("quotes a log path that contains a single quote", () => {
        const text = commandScript("/Users/o'brien/logs/demo.log", 'demo');
        assert.match(text, /exec tail -n 500 -F '\/Users\/o'\\''brien\/logs\/demo\.log'/);
    });
});

describe('server/src/server/procs.ts - shouldRotate', () => {
    // Rotation is at 5 MB exactly: a log at the limit is still the current log.
    test('rotates only once the log is past the limit', () => {
        assert.equal(shouldRotate(LOG_MAX_BYTES), false);
        assert.equal(shouldRotate(LOG_MAX_BYTES + 1), true);
    });
});
