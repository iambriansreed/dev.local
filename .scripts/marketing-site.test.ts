import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { marketingEntry, placeMarketingFirst, withMarketingFirst } from './marketing-site';
import type { SavedApp } from './marketing-site';

const site = {
    name: 'marketing.dev.local',
    port: 4180,
    path: '.',
    title: 'marketing.dev.local',
    custom: true,
    command: 'npm run dev:marketing',
};

describe('.scripts/marketing-site.ts - marketingEntry, withMarketingFirst', () => {
    test('keeps the entry as written but resolves path against the repo root', () => {
        assert.deepEqual(marketingEntry(site, '/repo'), { ...site, path: '/repo' });
    });

    test('adds no path when marketing.json has none', () => {
        const { path: _path, ...bare } = site;
        assert.deepEqual(marketingEntry(bare, '/repo'), bare);
    });

    test('puts the entry first and keeps the others in order', () => {
        const entry = { name: 'm', port: 1 };
        const list = [{ name: 'a', port: 2 }, { name: 'b', port: 3 }];
        assert.deepEqual(withMarketingFirst(list, entry), [entry, ...list]);
    });

    // A stale copy further down must not survive as a second app with the same name.
    test('moves and replaces an existing entry of the same name', () => {
        const entry = { name: 'm', port: 1 };
        const list = [{ name: 'a', port: 2 }, { name: 'm', port: 9 }, { name: 'b', port: 3 }];
        assert.deepEqual(withMarketingFirst(list, entry), [entry, list[0], list[2]]);
    });
});

describe('.scripts/marketing-site.ts - placeMarketingFirst', () => {
    let dir: string;
    let store: string;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-site-'));
        fs.writeFileSync(path.join(dir, 'marketing.json'), JSON.stringify(site));
        store = path.join(dir, 'home', 'proxies.json');
    });
    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('creates the store when there is none', () => {
        assert.ok(placeMarketingFirst({ root: dir, store }));
        assert.equal(JSON.parse(fs.readFileSync(store, 'utf8'))[0].port, 4180);
    });

    test('keeps what was already saved, after the marketing entry', () => {
        fs.writeFileSync(store, JSON.stringify([{ name: 'shop', port: 3000 }]));
        placeMarketingFirst({ root: dir, store });
        const saved: SavedApp[] = JSON.parse(fs.readFileSync(store, 'utf8'));
        const names = saved.map((a) => a.name);
        assert.deepEqual(names, ['marketing.dev.local', 'shop']);
    });

    test('writes nothing when the store already reads that way', () => {
        assert.equal(placeMarketingFirst({ root: dir, store }), undefined);
    });

    test('refuses a marketing.json without a port', () => {
        fs.writeFileSync(path.join(dir, 'marketing.json'), JSON.stringify({ name: 'm' }));
        assert.throws(() => placeMarketingFirst({ root: dir, store }), /name and a port/);
    });

    test('does nothing without a marketing.json', () => {
        fs.rmSync(path.join(dir, 'marketing.json'));
        assert.equal(placeMarketingFirst({ root: dir, store }), undefined);
    });
});
