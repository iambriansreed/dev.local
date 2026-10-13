/**
 * @file Puts the marketing site (`marketing.json` at the repo root) at the top of the saved apps
 * while `npm run dev` runs, so the menu and Settings list it before anything else. The saved apps
 * live in `~/.dev.localhost/proxies.json`, the same store the server reads and writes; this script
 * only ever moves or replaces the one entry it owns and leaves every other entry as it found it.
 *
 * @module marketing-site
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * An app as `proxies.json` stores it (see `Proxy` in server/src/shared/types.ts), which is also
 * the shape of `marketing.json`. Its `path` may be relative to the repo root.
 */
export type SavedApp = {
    name: string;
    port: number;
    path?: string;
    command?: string;
    custom?: boolean;
    title?: string;
};

/**
 * Makes the entry from `marketing.json` ready for the store: the only change is that a relative
 * `path` is resolved against the repo root, since the store needs an absolute one.
 *
 * @param site
 * @param root The repo root.
 */
export function marketingEntry(site: SavedApp, root: string): SavedApp {
    return site.path === undefined ? { ...site } : { ...site, path: path.resolve(root, site.path) };
}

/**
 * Returns the list with the marketing entry first. An existing entry of the same name is
 * replaced (so edits to `marketing.json` take effect); anything else keeps its order.
 *
 * @param list
 * @param entry
 */
export function withMarketingFirst(list: SavedApp[], entry: SavedApp): SavedApp[] {
    return [entry, ...list.filter((app) => app.name !== entry.name)];
}

/**
 * Reads the saved apps. A missing or unreadable store is an empty list, as the server treats it.
 *
 * @param file
 */
function readStore(file: string): SavedApp[] {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

/**
 * Reads `marketing.json` and writes it to the top of the store. Does nothing when the file is
 * absent, throws when it has no name or port, and skips the write when the store already reads that way, so a restart does not bump its mtime.
 *
 * @param [options]
 * @param [options.root] The repo root. Defaults to the one above this file.
 * @param [options.store] The store file. Defaults to `~/.dev.localhost/proxies.json`.
 * @returns A line to log when something was written.
 */
export function placeMarketingFirst({
    root = path.join(import.meta.dirname, '..'),
    store = path.join(os.homedir(), '.dev.localhost', 'proxies.json'),
}: { root?: string; store?: string } = {}): string | undefined {
    let site: SavedApp;
    try {
        site = JSON.parse(fs.readFileSync(path.join(root, 'marketing.json'), 'utf8'));
    } catch {
        return undefined;
    }
    if (!site.name || !Number.isInteger(site.port)) {
        throw new Error('marketing.json needs a name and a port, like an entry in proxies.json');
    }

    const before = readStore(store);
    const after = withMarketingFirst(before, marketingEntry(site, root));
    if (JSON.stringify(before) === JSON.stringify(after)) return undefined;

    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, `${JSON.stringify(after, null, 2)}\n`);
    return `${site.name} placed first in ${store}`;
}
