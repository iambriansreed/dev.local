/**
 * @file The Info.plist version substitution every release depends on.
 * `npm run test:scripts`.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readVersion, writeVersion } from './plist-version';

const PLIST = `<dict>
    <key>CFBundleName</key>
    <string>Menu OTP</string>
    <key>CFBundleShortVersionString</key>
    <string>0.1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
</dict>`;

test('reads the version', () => {
    assert.equal(readVersion(PLIST), '0.1.0');
});

test('writing changes only the version, as a one-line diff', () => {
    const updated = writeVersion(PLIST, '0.2.0');
    assert.equal(readVersion(updated), '0.2.0');
    assert.equal(updated, PLIST.replace('<string>0.1.0</string>', '<string>0.2.0</string>'));
});

test('a version starting with a digit after the capture group is written literally', () => {
    // '$1' + '0.10.0' would read as the group $10; the function replacement avoids it
    assert.equal(readVersion(writeVersion(PLIST, '0.10.0')), '0.10.0');
});

test('refuses a plist without the key, or with it twice', () => {
    assert.throws(() => readVersion('<dict></dict>'), /no CFBundleShortVersionString/);
    assert.throws(() => writeVersion('<dict></dict>', '1.0.0'), /found 0/);
    const twice = PLIST + PLIST;
    assert.throws(() => writeVersion(twice, '1.0.0'), /found 2/);
});
