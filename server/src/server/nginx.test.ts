// nginx.ts - title validation, and the /etc/hosts fix (the plan, the root command and the
// Terminal script that explains it) stay in step with what the menu bar app expects.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hostsCommand, hostsFixScript, planHostsFix, TITLE_MAX, validateProxy, validateTitle } from './nginx.ts';

describe('server/src/server/nginx.ts - validateTitle', () => {
    // A blank field must store nothing, or every proxy gets an empty label in the menu.
    test('an empty or blank title means no title at all', () => {
        assert.deepEqual(validateTitle(''), { value: null });
        assert.deepEqual(validateTitle('   '), { value: null });
        assert.deepEqual(validateTitle(undefined), { value: null });
    });

    test('a title is trimmed before it is stored', () => {
        assert.deepEqual(validateTitle('  Storefront  '), { value: 'Storefront' });
    });

    test('a title of exactly the limit is accepted, one more is not', () => {
        assert.equal(validateTitle('a'.repeat(TITLE_MAX)).value, 'a'.repeat(TITLE_MAX));
        assert.ok(validateTitle('a'.repeat(TITLE_MAX + 1)).error);
    });

    // The title is drawn as one menu label; a line break would split it across rows.
    test('a title with a line break is refused', () => {
        assert.ok(validateTitle('two\nlines').error);
    });
});

describe('server/src/server/nginx.ts - validateProxy keeps the title', () => {
    test('a proxy with a title stores it beside the other fields', () => {
        const r = validateProxy({ name: 'demo', port: 4321, title: ' Demo ' }, []);
        assert.equal(r.error, undefined);
        assert.equal(r.value?.title, 'Demo');
    });

    test('a proxy without a title stores no title key', () => {
        const r = validateProxy({ name: 'demo', port: 4321, title: '' }, []);
        assert.equal(r.value && 'title' in r.value, false);
    });
});

describe('server/src/server/nginx.ts - hostsCommand', () => {
    // One sudo call for the whole write, so it asks for the password once.
    test('copies the staged file over /etc/hosts in the same command as the cache flush', () => {
        const cmd = hostsCommand('/Users/me/.dev.localhost/hosts.staged');
        assert.match(cmd, /^\/bin\/cp '\/Users\/me\/\.dev\.localhost\/hosts\.staged' \/etc\/hosts/);
        if (process.platform === 'darwin') {
            assert.match(cmd, /dscacheutil -flushcache/);
            assert.match(cmd, /killall -HUP mDNSResponder/);
        }
    });

    // The flush is grouped after the copy, so a failed flush can't look like a failed write.
    test('the flush runs only after the copy has succeeded', () => {
        if (process.platform !== 'darwin') return;
        assert.match(hostsCommand('/tmp/x'), /\/etc\/hosts && \(/);
    });

    test('a path with a single quote is quoted, not spliced into the shell', () => {
        const cmd = hostsCommand("/Users/o'brien/hosts.staged");
        assert.ok(cmd.startsWith(`/bin/cp '/Users/o'\\''brien/hosts.staged' /etc/hosts`));
    });
});

const START = '# --- DEV.LOCALHOST_CONTENT_START ---';
const END = '# --- DEV.LOCALHOST_CONTENT_END ---';
const BASE = '127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1\tlocalhost\n';

describe('server/src/server/nginx.ts - planHostsFix', () => {
    test('a custom domain with no entry is added in a new block below the existing lines', () => {
        const plan = planHostsFix(BASE, ['app.example.com']);
        assert.ok(plan.ok);
        assert.deepEqual(plan.added, ['app.example.com']);
        assert.deepEqual(plan.removed, []);
        assert.equal(plan.next, `${BASE}\n${START}\n127.0.0.1\tapp.example.com\n${END}\n`);
    });

    test('a .localhost name never gets an entry, since it resolves on its own', () => {
        const plan = planHostsFix(BASE, ['myapp.localhost']);
        assert.ok(plan.ok);
        assert.equal(plan.next, BASE);
    });

    // A domain no proxy serves any more (renamed or deleted) leaves our block on the next fix.
    test('an entry in our block that no proxy uses is removed, and an empty block goes with it', () => {
        const text = `${BASE}\n${START}\n127.0.0.1\told.example.com\n${END}\n`;
        const plan = planHostsFix(text, []);
        assert.ok(plan.ok);
        assert.deepEqual(plan.removed, ['old.example.com']);
        assert.equal(plan.next, BASE);
    });

    // A line the user wrote by hand is theirs: never duplicated in our block, never removed.
    test('a domain already mapped by hand outside the block is left to that line', () => {
        const text = `${BASE}127.0.0.1\tmine.example.com\n`;
        const plan = planHostsFix(text, ['mine.example.com']);
        assert.ok(plan.ok);
        assert.deepEqual(plan.added, []);
        assert.equal(plan.next, text);
    });

    test('markers that do not pair up are refused rather than guessed at', () => {
        const plan = planHostsFix(`${BASE}${START}\n127.0.0.1\ta.example.com\n`, ['a.example.com']);
        assert.equal(plan.ok, false);
    });
});

describe('server/src/server/nginx.ts - hostsFixScript', () => {
    const script = hostsFixScript({
        staged: '/Users/me/.dev.localhost/hosts.staged',
        before: '/Users/me/.dev.localhost/hosts.before',
        added: ['new.example.com'],
        removed: ['old.example.com'],
        marker: START,
    });

    // The point of the script: say what changes and why sudo is needed, before it asks.
    test('names every line it adds and removes, and why it needs the password', () => {
        assert.match(script, /Adds:\n {4}127\.0\.0\.1 {2}new\.example\.com/);
        assert.match(script, /Removes .*:\n {4}127\.0\.0\.1 {2}old\.example\.com/);
        assert.match(script, /runs with sudo, which asks for the\npassword you use to log in/);
    });

    test('waits for Return before running sudo', () => {
        assert.ok(script.indexOf('read -r _') < script.indexOf('/usr/bin/sudo'));
    });

    // Copying a stale staged file would undo a hand edit made after the click.
    test('refuses to write when /etc/hosts changed after the plan was made', () => {
        assert.match(script, /if ! \/usr\/bin\/cmp -s \/etc\/hosts '\/Users\/me\/\.dev\.localhost\/hosts\.before'; then/);
        assert.ok(script.indexOf('/usr/bin/cmp') < script.indexOf('/usr/bin/sudo'));
    });

    test('runs the same root command as hostsCommand, quoted as one argument', () => {
        assert.match(script, /\/usr\/bin\/sudo \/bin\/sh -c '\/bin\/cp '\\''\/Users\/me\/\.dev\.localhost\/hosts\.staged'\\'' \/etc\/hosts/);
    });

    test('says nothing about adding when there is only a removal', () => {
        const only = hostsFixScript({ staged: '/s', before: '/b', added: [], removed: ['old.example.com'], marker: START });
        assert.doesNotMatch(only, /Adds:/);
    });
});

describe('server/src/server/nginx.ts - nginxCommandScript', () => {
    // nginx's Log tails both of its logs, each block labelled by its file name.
    test('tails the error and access logs together, from the last 200 lines', async () => {
        const { nginxCommandScript } = await import('./nginx.ts');
        const text = nginxCommandScript('/Users/me/.dev.localhost/logs');
        assert.ok(text.startsWith('#!/bin/sh\n'));
        assert.match(text, /exec tail -n 200 -F '\/Users\/me\/\.dev\.localhost\/logs\/error\.log' '\/Users\/me\/\.dev\.localhost\/logs\/access\.log'/);
    });
});
