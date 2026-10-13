// dev.localhost — nginx domain logic: store, cert, config generation, control.
// Zero dependencies. Node built-ins only.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The .ts extension is required: the server runs straight off source under Node,
// which resolves relative imports literally (tsc rewrites it to .js on emit).
import type { CertMethod, Live, Proxy, ProxyInput, ProxyState, State } from '../shared/types.ts';
// The dev servers themselves — spawning, signalling and buffering their output.
// Everything about a running process is in there; this file only ever hands it a
// name, a directory and a port.
import * as procs from './procs.ts';

// Re-exported so index.ts keeps importing its types from the module it already
// talks to, rather than having to know where they are declared.
export type { CertMethod, Proxy, ProxyInput, ProxyState, State } from '../shared/types.ts';

const HOME = os.homedir();

/** Where this server keeps its files, and the port its API and live socket listen on. */
export const config = {
    base: path.join(HOME, '.dev.localhost'),
    port: Number(process.env.DEV_LOCALHOST_PORT) || 7878,
};

/**
 * The hostname a proxy is served at. The single place `.localhost` gets appended
 * — a custom domain is already whole, and appending to it would serve
 * `myapp.test.localhost` instead of what the user asked for.
 */
export function proxyHost(p: Pick<Proxy, 'name' | 'custom'>): string {
    return p.custom ? p.name : `${p.name}${SUFFIX}`;
}

const SUFFIX = '.localhost';

// A validated value, or the reason it was rejected. The `?: undefined` arms let
// `if (v.error !== undefined)` narrow to the success case.
type Validated<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

export type CmdResult = {
    ok: boolean;
    out: string;
    code?: number | null;
    error?: Error;
};

export type CertResult = {
    ok: boolean;
    method: CertMethod;
    hosts: string[];
    out: string;
};

const P = {
    base: config.base,
    confD: path.join(config.base, 'conf.d'),
    certs: path.join(config.base, 'certs'),
    logs: path.join(config.base, 'logs'),
    store: path.join(config.base, 'proxies.json'),
    nginxConf: path.join(config.base, 'nginx.conf'),
    opensslCnf: path.join(config.base, 'certs', 'openssl.cnf'),
    crt: path.join(config.base, 'certs', 'localhost.crt'),
    key: path.join(config.base, 'certs', 'localhost.key'),
    hostsFile: path.join(config.base, 'certs', 'hosts.json'),
    // The 502 page nginx serves when nothing answers behind a proxy. Copied
    // here from src/ on every write, so it sits beside the config that names it
    // rather than at a path that depends on where the repo happens to live.
    errorPage: path.join(config.base, '502.html'),
};
export const paths = P;

// The server folder: dist/server/nginx.js or src/server/nginx.ts, two levels down from it
// either way. DEV_LOCALHOST_ROOT wins, for the copy inside the app bundle.
export const ROOT = process.env.DEV_LOCALHOST_ROOT || path.resolve(import.meta.dirname, '..', '..');

// The 502 page as authored, beside the stylesheet: the assets ship as they are.
const ERROR_PAGE_SRC = path.join(ROOT, 'assets', '502.html');

// Names that can't be used for a proxy (they belong to the tool / nginx itself).
const RESERVED = new Set(['localhost', 'www']);

// ---------------------------------------------------------------- shell helpers

function sh(cmd: string, args: string[], opts: SpawnSyncOptions = {}): CmdResult {
    const r = spawnSync(cmd, args, { ...opts, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    return { ok: r.status === 0, code: r.status, out, error: r.error };
}

function which(bin: string): string | null {
    const r = sh('/bin/sh', ['-c', `command -v ${bin}`]);
    return r.ok && r.out ? r.out.split('\n')[0].trim() : null;
}

// Progress lines printed to the terminal running the server (or the server log, when the
// menu bar app runs it).
function logConsole(msg: string): void {
    console.log(`  ${msg}`);
}

// ---------------------------------------------------------------- filesystem

function ensureDirs(): void {
    for (const d of [P.base, P.confD, P.certs, P.logs]) {
        fs.mkdirSync(d, { recursive: true });
    }
}

/**
 * Put the 502 page where nginx can read it. Returns false if it isn't there to
 * copy — the config then leaves the `error_page` rules out entirely rather than
 * pointing nginx at a file that doesn't exist, which would turn every 502 into
 * a 404 and lose the one bit of information the visitor actually needed.
 *
 * Copied on every write rather than once: editing the page and hitting Apply is
 * how you'd want to iterate on it.
 */
function installErrorPage(): boolean {
    try {
        fs.copyFileSync(ERROR_PAGE_SRC, P.errorPage);
        // The worker reads this one as the user (see `user` in rootConf), but a
        // file that arrives 0600 from a tight umask would still be unreadable
        // if that ever changes. Cheap insurance on a page with no secrets.
        fs.chmodSync(P.errorPage, 0o644);
        return true;
    } catch {
        return false;
    }
}

// The store. `rev` changes on every write, so the live push can tell a client that
// the list it is showing is stale (see liveStatus). Starts at the clock, so a restart
// never hands out a number a client has already seen.
let rev = Date.now();

export function revision(): number {
    return rev;
}

export function loadProxies(): Proxy[] {
    try {
        const raw = fs.readFileSync(P.store, 'utf8');
        const data: unknown = JSON.parse(raw);
        return Array.isArray(data) ? (data as Proxy[]) : [];
    } catch {
        return [];
    }
}

function saveProxies(list: Proxy[]): void {
    ensureDirs();
    fs.writeFileSync(P.store, `${JSON.stringify(list, null, 2)}\n`);
    rev = Math.max(rev + 1, Date.now());
}

// ---------------------------------------------------------------- nginx discovery

const NGINX_FALLBACKS = ['/opt/homebrew/bin/nginx', '/usr/local/bin/nginx', '/usr/sbin/nginx'];

export function nginxBin(): string | null {
    const found = which('nginx');
    if (found) return found;
    for (const p of NGINX_FALLBACKS) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function nginxVersion(bin: string | null): string | null {
    if (!bin) return null;
    const r = sh(bin, ['-v']); // prints to stderr
    const m = r.out.match(/nginx\/([\d.]+)/);
    return m ? m[1] : null;
}

// Is *our* managed nginx running? Match the master process started with our
// config path — this ignores a stale pid file (whose PID may have been reused)
// and any other nginx the user runs on a different config.
export function nginxRunning(): boolean {
    const r = sh('/bin/sh', ['-c', `pgrep -f "nginx: master process.*${P.nginxConf}"`]);
    return r.ok && Boolean(r.out.trim());
}

// An nginx master process that isn't ours, with the config it was started from.
// It still owns ports 80/443, so our start will fail to bind — and since it runs
// on a different config, `nginxRunning()` correctly reports "not running". That
// combination is the usual cause of a mystifying start failure, so name it.
export function foreignNginx(): { pid: number; conf: string } | null {
    const r = sh('/bin/sh', ['-c', 'pgrep -fl "nginx: master process"']);
    for (const line of r.out.split('\n')) {
        const m = line.match(/^(\d+)\s+nginx: master process\s*(.*)$/);
        if (!m) continue;
        const conf = m[2].match(/-c\s+(\S+)/)?.[1] ?? '';
        if (conf === P.nginxConf) continue; // that one is ours
        return { pid: Number(m[1]), conf: conf || '(compiled-in default config)' };
    }
    return null;
}

// The set of TCP ports with a listening socket right now (any address/family).
// Used to tell whether a proxy's dev server is up.
export function listeningPorts(): Set<number> {
    const r = sh('/bin/sh', ['-c', 'lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null']);
    const set = new Set<number>();
    for (const m of r.out.matchAll(/:(\d+) \(LISTEN\)/g)) set.add(Number(m[1]));
    return set;
}

// ---------------------------------------------------------------- certificates

function mkcertBin(): string | null {
    return which('mkcert');
}

function mkcertVersion(): string | null {
    const bin = mkcertBin();
    if (!bin) return null;
    const m = sh(bin, ['-version']).out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

function opensslVersion(): string | null {
    const m = sh('openssl', ['version']).out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
}

// The hostnames the current cert on disk was issued for. Written whenever we
// (re)provision, so we can tell which proxies are already covered.
function readCoveredHosts(): string[] {
    try {
        const data: unknown = JSON.parse(fs.readFileSync(P.hostsFile, 'utf8'));
        return Array.isArray(data) ? (data as string[]) : [];
    } catch {
        return [];
    }
}

function writeCoveredHosts(hosts: string[]): void {
    fs.writeFileSync(P.hostsFile, `${JSON.stringify(hosts, null, 2)}\n`);
}

// A `*.localhost` SAN entry matches exactly one label, so it covers
// myapp.localhost but not storybook.ui.localhost.
function hostCoveredByWildcard(host: string): boolean {
    return /^[a-z0-9-]+\.localhost$/.test(host);
}

// Is a given hostname covered by the cert currently on disk?
export function hostCovered(host: string): boolean {
    const hosts = readCoveredHosts();
    if (hosts.includes(host)) return true;
    if (hosts.includes('*.localhost') && hostCoveredByWildcard(host)) return true;
    return false;
}

// Every hostname the cert should cover: localhost, and one entry per proxy.
function desiredHosts(): string[] {
    const hosts = ['localhost', ...loadProxies().map(proxyHost)];
    return hosts.filter((h, i) => hosts.indexOf(h) === i);
}

export function certInfo() {
    const exists = fs.existsSync(P.crt) && fs.existsSync(P.key);
    const method: CertMethod | null = exists
        ? fs.existsSync(path.join(P.certs, '.mkcert'))
            ? 'mkcert'
            : 'openssl'
        : null;
    return {
        exists,
        method,
        version: method === 'mkcert' ? mkcertVersion() : method === 'openssl' ? opensslVersion() : null,
        mkcertAvailable: Boolean(mkcertBin()),
        hosts: readCoveredHosts(),
        crt: P.crt,
        key: P.key,
        // Only self-signed openssl certs need manual trusting.
        trustCmd:
            exists && method === 'openssl'
                ? `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${P.crt}"`
                : null,
    };
}

function generateWithMkcert(bin: string, hosts: string[]): CertResult {
    logConsole('→ Provisioning TLS certificate…');
    // -install adds the local CA to the system + browser trust stores (no-op if
    // already installed). Then issue a single cert covering every host.
    const install = sh(bin, ['-install']);
    const gen = sh(bin, ['-cert-file', P.crt, '-key-file', P.key, ...hosts, '127.0.0.1', '::1']);
    if (gen.ok) {
        fs.writeFileSync(path.join(P.certs, '.mkcert'), 'generated by mkcert\n');
        writeCoveredHosts(hosts);
    }
    return { ok: gen.ok, method: 'mkcert', hosts, out: `${install.out}\n${gen.out}`.trim() };
}

// openssl can't chain to a trusted CA, so instead of a leaf-per-host we issue one
// self-signed *.localhost wildcard, which covers every current and future
// single-label proxy without regenerating. A wildcard only matches one label
// though, so nested names (storybook.ui.localhost) get their own SAN entry — and
// adding one does mean re-issuing, hence re-trusting, the cert.
function generateWithOpenssl(extraHosts: string[] = []): CertResult {
    logConsole('→ Provisioning TLS certificate…');
    const covered = ['*.localhost', 'localhost', ...extraHosts];
    const alt = [
        'DNS:*.localhost',
        'DNS:localhost',
        ...extraHosts.map((h) => `DNS:${h}`),
        'IP:127.0.0.1',
        'IP:0:0:0:0:0:0:0:1',
    ].join(', ');
    const cnf = `[req]
distinguished_name = dn
x509_extensions = v3
prompt = no

[dn]
CN = *.localhost

[v3]
subjectAltName = ${alt}
basicConstraints = critical, CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
`;
    fs.writeFileSync(P.opensslCnf, cnf);
    const r = sh('openssl', [
        'req',
        '-x509',
        '-nodes',
        '-newkey',
        'rsa:2048',
        '-keyout',
        P.key,
        '-out',
        P.crt,
        '-days',
        '3650',
        '-config',
        P.opensslCnf,
        '-extensions',
        'v3',
    ]);
    if (r.ok) {
        try {
            fs.rmSync(path.join(P.certs, '.mkcert'), { force: true });
        } catch {
            /* ignore */
        }
        writeCoveredHosts(covered);
    }
    return { ok: r.ok, method: 'openssl', hosts: covered, out: r.out };
}

// Ensure the cert on disk covers every current host. With mkcert we regenerate
// so a newly-added proxy gets its own trusted name; with openssl the wildcard
// already covers it, so we only generate once.
export function provisionCert(): CertResult {
    ensureDirs();
    const hosts = desiredHosts();
    const mk = mkcertBin();
    if (mk) {
        const already = readCoveredHosts();
        const covered = fs.existsSync(P.crt) && hosts.every((h) => already.includes(h));
        if (covered)
            return { ok: true, method: 'mkcert', hosts, out: 'certificate already covers all hosts' };
        return generateWithMkcert(mk, hosts);
    }
    // The wildcard handles single-label hosts; only a nested one that isn't in
    // the cert's SAN list forces a re-issue.
    const exists = fs.existsSync(P.crt) && fs.existsSync(P.key);
    if (exists && hosts.every(hostCovered)) {
        return {
            ok: true,
            method: 'openssl',
            hosts: readCoveredHosts(),
            out: 'wildcard cert already covers all hosts',
        };
    }
    return generateWithOpenssl(hosts.filter((h) => h !== 'localhost' && !hostCoveredByWildcard(h)));
}

// ---------------------------------------------------------------- /etc/hosts
// `.localhost` is special-cased by the resolver (RFC 6761) and needs nothing.
// Any other domain resolves nowhere until something maps it, so a custom domain
// needs a line in /etc/hosts pointing at 127.0.0.1.
//
// We only ever manage fenced blocks and never touch a line outside one —
// /etc/hosts is a file people edit by hand, and an entry we didn't write isn't
// ours to remove.

const HOSTS_PATH = '/etc/hosts';

// The fences we recognise. SwitchHosts is the tool this used to point people at
// for exactly this job, so a machine that has been managed by it already has
// that block — reading it means those entries are recognised rather than
// duplicated, and writing to it keeps everything in one place instead of
// starting a rival block underneath.
//
// The first pair is the one we create when a file has neither.
const BLOCK_MARKERS = [
    { start: '# --- DEV.LOCALHOST_CONTENT_START ---', end: '# --- DEV.LOCALHOST_CONTENT_END ---' },
    { start: '# --- SWITCHHOSTS_CONTENT_START ---', end: '# --- SWITCHHOSTS_CONTENT_END ---' },
];
const DEFAULT_MARKER = BLOCK_MARKERS[0];

// Reading counts every loopback address (an entry the user wrote may well use
// ::1), but we only ever *write* 127.0.0.1: nginx's `listen 443` binds IPv4
// only, so mapping a host to ::1 too would hand the browser an address with
// nothing listening on it.
const LOOPBACK_V4 = '127.0.0.1';
const LOOPBACK = new Set([LOOPBACK_V4, '::1']);

// null when the file can't be read — distinct from "read an empty file", since
// we must never rewrite /etc/hosts from a blank slate.
function readHostsFile(): string | null {
    try {
        return fs.readFileSync(HOSTS_PATH, 'utf8');
    } catch {
        return null;
    }
}

// The hostnames on one `127.0.0.1 a b c` line, or none if it isn't loopback.
// Tokens come back exactly as written — see tidyHost for the repaired form.
function hostsOnLine(raw: string): string[] {
    const line = raw.split('#')[0].trim();
    if (!line) return [];
    const [addr, ...names] = line.split(/\s+/);
    return LOOPBACK.has(addr) ? names.map((n) => n.toLowerCase()) : [];
}

/**
 * A hostname with a pasted-URL hangover cleaned off: scheme, and anything from
 * the first slash on. `127.0.0.1 example.com/` looks right at a glance but the
 * resolver never matches it, so an entry like that silently does nothing —
 * rewriting a block we manage is the moment to quietly put it right.
 */
function tidyHost(host: string): string {
    return host
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .split(/[/?#]/)[0]
        .replace(/\.+$/, '');
}

// Every hostname the file actually points at loopback — ours and the user's own
// alike. Deliberately *not* tidied: `example.com/` doesn't resolve, so counting
// it as present would hide a broken entry behind a green tick.
function parseHosts(text: string): Set<string> {
    return new Set(text.split('\n').flatMap(hostsOnLine));
}

type Block = {
    /** Index of the START marker. */
    from: number;
    /** Index of the last line the block owns — its END marker, or EOF. */
    to: number;
    /** Exclusive end of the block's content lines. */
    contentTo: number;
    marker: (typeof BLOCK_MARKERS)[number];
};

// Every managed block present, in the order they appear in the file. A START
// with no END is read as owning everything to the end of the file, so the
// entries under it still count as ours when we are only looking. Nothing is
// ever *written* on that reading — markersBalanced refuses it, because the same
// assumption applied to a rewrite would delete the rest of the file.
function findBlocks(lines: string[]): Block[] {
    const found: Block[] = [];
    for (const marker of BLOCK_MARKERS) {
        const from = lines.findIndex((l) => l.trim() === marker.start);
        if (from === -1) continue;
        const end = lines.findIndex((l, i) => i > from && l.trim() === marker.end);
        found.push(
            end === -1
                ? { from, to: lines.length - 1, contentTo: lines.length, marker }
                : { from, to: end, contentTo: end, marker },
        );
    }
    return found.sort((a, b) => a.from - b.from);
}

// At most one of each marker, and never an END above its own START. Anything
// else is a file edited mid-block — a block pasted twice, a stray END — and we
// can no longer tell which lines belong to whom. Refusing beats guessing: the
// wrong guess deletes a line somebody wrote by hand.
function markersBalanced(lines: string[]): boolean {
    const count = (marker: string) => lines.filter((l) => l.trim() === marker).length;
    const eachSound = BLOCK_MARKERS.every((m) => {
        const [starts, ends] = [count(m.start), count(m.end)];
        if (starts === 0) return ends === 0; // no block of this kind, or a stray END
        if (starts > 1 || ends > 1) return false;
        // Unterminated. findBlocks will close it at EOF, which is right for
        // *reading* — the entries above are still ours to report. It is not
        // right for writing: closing at EOF hands the block every line below it,
        // and rewriting the block then deletes them. Those lines are exactly the
        // ones this whole section promises not to touch, and a missing END is no
        // evidence at all that they are ours. So reading carries on and writing
        // stops here, with an error naming the marker to put back.
        if (ends === 0) return false;
        return lines.findIndex((l) => l.trim() === m.start) < lines.findIndex((l) => l.trim() === m.end);
    });
    if (!eachSound) return false;

    // Sound one at a time is not enough: two blocks must also not overlap. One
    // opened inside the other (DEV_START, SWITCH_START, DEV_END, SWITCH_END)
    // passes every check above — each marker appears once, each END below its
    // own START — while owning ranges that share lines. renderHosts splices
    // those ranges away bottom-up, which assumes they are disjoint; overlapping
    // ones shift the indices under each other and the second splice runs off the
    // end of the block, taking whatever hand-written lines follow it.
    //
    // findBlocks returns them in file order, so adjacent pairs are all we check.
    const blocks = findBlocks(lines);
    return blocks.every((b, i) => i === 0 || blocks[i - 1].to < b.from);
}

// The hostnames inside the managed blocks: the only ones we will ever remove.
// Tidied, so a slash-mangled entry is recognised as the host it was meant to be
// and gets written back correctly.
function blockHosts(text: string): string[] {
    const lines = text.split('\n');
    const hosts = findBlocks(lines).flatMap((b) =>
        lines
            .slice(b.from + 1, b.contentTo)
            .flatMap(hostsOnLine)
            .map(tidyHost),
    );
    return [...new Set(hosts.filter(Boolean))];
}

// `text` with the managed block rewritten to hold exactly `hosts`. Everything
// outside the fences is preserved verbatim. An empty list takes the markers
// with it, rather than leaving a pair of fenceposts around nothing.
//
// Entries land in the first block already in the file, so a machine that
// already had a SwitchHosts block keeps using it; any second managed block is
// emptied out, consolidating rather than maintaining two.
function renderHosts(text: string, hosts: string[]): string {
    const lines = text.replace(/\s+$/, '').split('\n');
    const wanted = [...new Set(hosts.map(tidyHost).filter(Boolean))];
    const blocks = findBlocks(lines);
    const marker = blocks[0]?.marker ?? DEFAULT_MARKER;
    const block = wanted.length
        ? [marker.start, ...wanted.map((h) => `${LOOPBACK_V4}\t${h}`), marker.end]
        : [];

    if (blocks.length) {
        // Bottom-up, so each splice leaves the earlier indices valid.
        for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            lines.splice(b.from, b.to - b.from + 1, ...(i === 0 ? block : []));
        }
    } else if (block.length) {
        lines.push('', ...block);
    }
    // Removing a block leaves the blank line that separated it behind.
    return `${lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, '')}\n`;
}

// Single-quote a value for `sh`. Paths here never contain one, but the staged files
// live under the home directory, so they are quoted rather than trusted.
function shQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The one root command a hosts write runs: copy the staged file over /etc/hosts, then
 * drop the resolver cache. Both in one `sh -c`, so a write asks for the password once
 * however many steps it has. `cp` onto the existing file keeps its owner and mode,
 * which a `mv` would replace with ours.
 *
 * macOS caches negative lookups, so a name added a moment ago can keep failing in the
 * browser until the cache is dropped. The flush is best-effort: its failure only costs
 * the user a wait, so it is grouped after the copy and cannot undo it.
 */
export function hostsCommand(staged: string): string {
    const copy = `/bin/cp ${shQuote(staged)} ${HOSTS_PATH}`;
    if (process.platform !== 'darwin') return copy;
    return `${copy} && (/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder)`;
}

/** What a fix would do to /etc/hosts, worked out without writing anything. */
export type HostsPlan =
    | { ok: false; error: string }
    | { ok: true; next: string; added: string[]; removed: string[]; marker: string };

/**
 * The managed block as it should stand for `hosts` (every domain the store serves):
 * one entry per custom domain, and nothing for a domain no proxy uses any more.
 *
 * A `.localhost` name resolves on its own, and a domain the user already maps by hand
 * outside our block is theirs, so neither gets an entry. Pure, so the server and its
 * tests read the same answer.
 */
export function planHostsFix(text: string, hosts: string[]): HostsPlan {
    const lines = text.split('\n');
    if (!markersBalanced(lines)) {
        return {
            ok: false,
            error:
                `A managed block in ${HOSTS_PATH} has markers that don't pair up, so it isn't clear ` +
                `which lines belong to it: every START needs its own END below it, and two blocks ` +
                `can't overlap. Nothing was changed. Tidy the markers by hand, then try again.`,
        };
    }
    const managed = blockHosts(text);
    const elsewhere = parseHosts(renderHosts(text, []));
    const wanted = [...new Set(hosts.map(normalizeHost))].filter(
        (h) => h && h !== 'localhost' && !h.endsWith(SUFFIX) && !elsewhere.has(h),
    );
    return {
        ok: true,
        next: renderHosts(text, wanted),
        added: wanted.filter((h) => !managed.includes(h)),
        removed: managed.filter((h) => !wanted.includes(h)),
        marker: (findBlocks(lines)[0]?.marker ?? DEFAULT_MARKER).start,
    };
}

/**
 * The script Terminal runs when Fix hosts entry is clicked. It says what it is about to
 * change and why that needs an administrator password, waits for Return, then runs the
 * one sudo command. The server never runs sudo itself: a prompt that names nothing but
 * "sudo" tells nobody what they are agreeing to.
 *
 * `before` is the file the plan was made from. If /etc/hosts has changed since (edited
 * by hand, or another fix), copying the staged file would undo that, so the script
 * stops and asks for a fresh click instead.
 */
export function hostsFixScript(p: { staged: string; before: string; added: string[]; removed: string[]; marker: string }): string {
    const list = (hosts: string[]) => hosts.map((h) => `    ${LOOPBACK_V4}  ${h}`).join('\n');
    const changes = [
        p.added.length ? `Adds:\n${list(p.added)}` : '',
        p.removed.length ? `Removes (no app uses these domains any more):\n${list(p.removed)}` : '',
    ]
        .filter(Boolean)
        .join('\n\n');
    const staged = shQuote(p.staged);
    const before = shQuote(p.before);
    return `#!/bin/sh
# Written by dev.localhost for Fix hosts entry. Safe to delete; it is rewritten on every click.
printf '\\033]0;dev.localhost: update /etc/hosts\\007'
clear
cat <<'DEV_LOCAL_EOF'
dev.localhost wants to update ${HOSTS_PATH}.

A custom domain (anything not ending in .localhost) only reaches this Mac when
${HOSTS_PATH} points it at ${LOOPBACK_V4}. dev.localhost keeps its entries in one block,
starting at the line "${p.marker}",
and never touches a line outside it.

${changes}

${HOSTS_PATH} belongs to the system, so the copy runs with sudo, which asks for the
password you use to log in to this Mac. The same command clears macOS's DNS cache,
so the browser sees the change at once.

The new file is ${p.staged}
if you want to read it first.
DEV_LOCAL_EOF
echo
printf 'Press Return to continue, or Ctrl+C to cancel. '
read -r _ || exit 1
if ! /usr/bin/cmp -s ${HOSTS_PATH} ${before}; then
    echo
    echo "${HOSTS_PATH} changed after this was prepared, so nothing was written."
    echo "Click Fix hosts entry again for an up-to-date version."
    exit 1
fi
echo
if /usr/bin/sudo /bin/sh -c ${shQuote(hostsCommand(p.staged))}; then
    /bin/rm -f ${staged} ${before}
    echo
    echo "Done. ${HOSTS_PATH} is updated, and dev.localhost will show it in a moment."
    echo "You can close this window."
else
    echo
    echo "Nothing was changed."
fi
`;
}

export type HostsFix = { ok: false; error: string } | { ok: true; changed: false } | { ok: true; changed: true; script: string };

/**
 * Prepare a fix: the new /etc/hosts staged in ~/.dev.localhost, and the script that
 * copies it into place. Nothing root-owned is touched here; the app opens the script
 * in Terminal. `changed: false` means the file already says what it should.
 */
export function prepareHostsFix(): HostsFix {
    const text = readHostsFile();
    if (text === null) return { ok: false, error: `Could not read ${HOSTS_PATH}.` };
    const plan = planHostsFix(text, loadProxies().map(proxyHost));
    if (!plan.ok) return plan;
    if (plan.next === text) return { ok: true, changed: false };
    ensureDirs();
    const staged = path.join(P.base, 'hosts.staged');
    const before = path.join(P.base, 'hosts.before');
    const script = path.join(P.base, 'hosts.command');
    fs.writeFileSync(staged, plan.next);
    fs.writeFileSync(before, text);
    fs.writeFileSync(script, hostsFixScript({ staged, before, ...plan }), { mode: 0o755 });
    fs.chmodSync(script, 0o755);
    return { ok: true, changed: true, script };
}

/**
 * Watch /etc/hosts and bump the store revision when it changes, so the app refreshes
 * and a fixed row loses its warning without anyone reloading. Polled, since `cp` and
 * hand edits replace the file in different ways and a poll sees both.
 */
export function watchHostsFile(): void {
    fs.watchFile(HOSTS_PATH, { interval: 1000 }, (now, before) => {
        if (now.mtimeMs !== before.mtimeMs) rev = Math.max(rev + 1, Date.now());
    });
}

// Same cleanup a hosts-file token gets, so pasting a whole URL where a domain
// was asked for lands on the domain.
function normalizeHost(raw: unknown): string {
    return tidyHost(String(raw || ''));
}

// What Settings needs to know about /etc/hosts: which names resolve to
// loopback at all, and which of those we put there.
export function hostsInfo(): { path: string; entries: string[]; managed: string[] } {
    const text = readHostsFile() ?? '';
    return { path: HOSTS_PATH, entries: [...parseHosts(text)], managed: blockHosts(text) };
}

export type HostsFile = {
    path: string;
    ok: boolean;
    error?: string;
    /** The file with our blocks lifted out — what was here before us, and what
     *  the user maintains by hand. */
    original: string;
    /** What's inside our fences, markers left off: the lines we put there. */
    managed: string;
};

/**
 * The file as two blocks of text — the part that isn't ours, and the part that
 * is — for showing back to whoever wants to see what we've been writing.
 *
 * Kept out of hostsInfo, which rides along on every status push: the whole file
 * has no business crossing the wire a couple of times a second for a panel that
 * is almost never open. This is read on demand instead.
 */
export function hostsFile(): HostsFile {
    const text = readHostsFile();
    if (text === null) {
        return {
            path: HOSTS_PATH,
            ok: false,
            error: `Could not read ${HOSTS_PATH}.`,
            original: '',
            managed: '',
        };
    }
    const lines = text.replace(/\s+$/, '').split('\n');

    // Every line a managed block covers, markers included. A Set rather than a
    // range, because a hand-mangled file can have blocks that overlap — writing
    // refuses that (see markersBalanced), but a read-only view should still
    // show what's there rather than nothing at all.
    const owned = new Set<number>();
    const ours: string[] = [];
    for (const b of findBlocks(lines)) {
        for (let i = b.from; i <= b.to; i++) owned.add(i);
        for (let i = b.from + 1; i < b.contentTo; i++) ours.push(lines[i]);
    }

    // Lifting a block out leaves the blank line that separated it behind, so
    // both halves get the same tidy-up: no leading or trailing blank lines, and
    // no runs of them in the middle.
    const tidy = (ls: string[]) =>
        ls
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    return {
        path: HOSTS_PATH,
        ok: true,
        original: tidy(lines.filter((_, i) => !owned.has(i))),
        managed: tidy(ours),
    };
}

// ---------------------------------------------------------------- config generation

/**
 * The rules that put our 502 page in front of nginx's own.
 *
 * Deliberately no `proxy_intercept_errors`: that would swallow a 502 the *app*
 * returned, which is the app's to explain, not ours. Only the gateway failures
 * nginx itself invents — nothing listening on the port, or a connect that timed
 * out — reach `error_page`, and those are exactly the ones the page describes.
 *
 * The location is `internal`, so the URI is unreachable from outside and can't
 * be linked to; and it carries its own `default_type` because this config
 * includes no mime.types, and an .html served as octet-stream downloads instead
 * of rendering.
 */
function errorPageRules(indent: string): string {
    const pad = (s: string) => s.replace(/^(?=.)/gm, indent);
    return pad(`
error_page 502 504 /__dev.localhost/502.html;

location = /__dev.localhost/502.html {
    internal;
    alias ${P.errorPage};
    default_type text/html;
}
`);
}

function proxyServerBlock(p: Proxy, errorPage: boolean): string {
    const host = proxyHost(p);
    return `# ${host}  ->  http://localhost:${p.port}   (managed by dev.localhost)
server {
    listen 443 ssl;
    http2 on;
    server_name ${host};

    ssl_certificate     ${P.crt};
    ssl_certificate_key ${P.key};
${errorPage ? errorPageRules('    ') : ''}
    location / {
        # localhost (not 127.0.0.1) so this works whether the app binds IPv4 or
        # IPv6 loopback — nginx tries both resolved addresses and fails over.
        proxy_pass http://localhost:${p.port};
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_read_timeout 86400s;
    }
}
`;
}

// nginx runs as the user who started it. Ports 80 and 443 are bound on the wildcard
// address, which macOS lets an ordinary user do (a specific address like 127.0.0.1:80
// would still need root), so no `user` line is needed: the workers are already us, and
// they can read ~/.dev.localhost.
function rootConf(errorPage: boolean): string {
    return `# Managed by dev.localhost — do not edit by hand, changes are overwritten.
worker_processes 1;
pid ${path.join(P.logs, 'nginx.pid')};
error_log ${path.join(P.logs, 'error.log')} warn;

events {
    worker_connections 1024;
}

http {
    access_log ${path.join(P.logs, 'access.log')};
    default_type application/octet-stream;
    sendfile on;
    server_names_hash_bucket_size 128;
    client_max_body_size 100m;

    # nginx listens on every interface, so only this Mac may use it. Anything else on the
    # network gets a 403 rather than the apps behind it.
    allow 127.0.0.1;
    allow ::1;
    deny all;

    # Support WebSocket / HMR upgrades through the proxy.
    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    # Redirect every plain-http *.localhost request to https.
    server {
        listen 80 default_server;
        server_name localhost *.localhost;
        return 301 https://$host$request_uri;
    }

    # Catch-all for https: a name no app serves has its TLS handshake refused, rather than
    # landing on whichever app's block nginx happened to load first. Needs no certificate.
    server {
        listen 443 ssl default_server;
        ssl_reject_handshake on;
    }

    # One file per proxy lives here.
    include ${P.confD}/*.conf;
}
`;
}

/**
 * The script Terminal runs for nginx's Log: both logs at once, `tail -F` labelling each
 * block with its file name. Written beside them on every apply, like the 502 page.
 */
export function nginxCommandScript(logDir: string): string {
    const q = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;
    return [
        '#!/bin/sh',
        "printf '\\033]0;%s\\007' 'nginx.log'",
        `exec tail -n 200 -F ${q(path.join(logDir, 'error.log'))} ${q(path.join(logDir, 'access.log'))}`,
        '',
    ].join('\n');
}

// Write nginx.conf + one conf.d file per proxy. Reflects the given list exactly.
export function writeConfigs(list: Proxy[]): void {
    ensureDirs();
    const command = path.join(P.logs, 'nginx.command');
    fs.writeFileSync(command, nginxCommandScript(P.logs), { mode: 0o755 });
    fs.chmodSync(command, 0o755);
    // Before the config, which only names the page if it made it into place.
    const errorPage = installErrorPage();
    fs.writeFileSync(P.nginxConf, rootConf(errorPage));
    // Clear old per-proxy files, then write current ones.
    for (const f of fs.readdirSync(P.confD)) {
        if (f.endsWith('.conf')) fs.rmSync(path.join(P.confD, f), { force: true });
    }
    // Named after the host, not the name: `storybook.ui` and a custom
    // `storybook.ui` are different hosts and must not share a file.
    for (const p of list) {
        fs.writeFileSync(path.join(P.confD, `${proxyHost(p)}.conf`), proxyServerBlock(p, errorPage));
    }
}

// ---------------------------------------------------------------- nginx control

function requireBin(): { bin: string; error?: undefined } | { bin?: undefined; error: string } {
    const bin = nginxBin();
    if (!bin) {
        return {
            error: 'nginx is not installed. Install it with: brew install nginx',
        };
    }
    return { bin };
}

// nginx itself never needs root now (see rootConf), so these run it directly.

export function testConfig(): CmdResult {
    const req = requireBin();
    if (req.error !== undefined) return { ok: false, out: req.error };
    return sh(req.bin, ['-t', '-c', P.nginxConf]);
}

export function startNginx(): CmdResult {
    const req = requireBin();
    if (req.error !== undefined) return { ok: false, out: req.error };
    return sh(req.bin, ['-c', P.nginxConf]);
}

export function reloadNginx(): CmdResult {
    const req = requireBin();
    if (req.error !== undefined) return { ok: false, out: req.error };
    return sh(req.bin, ['-s', 'reload', '-c', P.nginxConf]);
}

export function stopNginx(): CmdResult {
    const req = requireBin();
    if (req.error !== undefined) return { ok: false, out: req.error };
    return sh(req.bin, ['-s', 'stop', '-c', P.nginxConf]);
}

export type ApplyResult = {
    ok: boolean;
    step: 'nginx' | 'cert' | 'test' | 'start' | 'reload' | 'none';
    out?: string;
    cert?: { method: CertMethod; hosts: string[] };
};

/**
 * Provision the cert, write configs, validate, then reload (or start) nginx.
 *
 * Nothing here asks for a password any more: nginx runs as the user, so there is no
 * root call for it to wait on.
 */
export function apply(): ApplyResult {
    const { error } = requireBin();
    if (error) {
        logConsole('✗ nginx is not installed — run: brew install nginx');
        return { ok: false, step: 'nginx', out: error };
    }

    // No line for this step. provisionCert() short-circuits when the cert already
    // covers every host, which is every run but the first — announcing it here
    // meant every proxy edit and every reload claimed work that never happened.
    // The two generators say so themselves, so the message appears exactly when
    // there is something to wait for.
    const cert = provisionCert();
    if (!cert.ok) {
        logConsole('✗ Certificate provisioning failed');
        return { ok: false, step: 'cert', out: cert.out };
    }

    writeConfigs(loadProxies());

    const wasRunning = nginxRunning();
    logConsole(`→ ${wasRunning ? 'Reloading' : 'Starting'} nginx…`);

    const test = testConfig();
    if (!test.ok) {
        logConsole('✗ nginx config test failed');
        return { ok: false, step: 'test', out: test.out };
    }

    const action = wasRunning ? reloadNginx() : startNginx();
    const step = wasRunning ? 'reload' : 'start';
    let out = `${test.out}\n${action.out}`.trim();
    if (action.ok) {
        logConsole(
            `✓ SUCCESS — nginx ${wasRunning ? 'reloaded' : 'started'}.`,
        );
    } else {
        logConsole(`✗ nginx ${step} failed`);
        // "Address already in use" almost always means another nginx holds 80/443.
        const other = /Address already in use/i.test(out) ? foreignNginx() : null;
        if (other) {
            out = [
                out,
                '',
                `Another nginx (pid ${other.pid}) is already using ports 80 and 443.`,
                `It was started from a different config: ${other.conf}`,
                `Stop it, then retry:  sudo kill ${other.pid}`,
            ].join('\n');
        }
    }
    return {
        ok: action.ok,
        step,
        cert: { method: cert.method, hosts: cert.hosts },
        out,
    };
}

function confExists(host: string): boolean {
    return fs.existsSync(path.join(P.confD, `${host}.conf`));
}

// ---------------------------------------------------------------- proxy CRUD

// A single DNS label: 1–63 chars, no leading/trailing dash.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// A proxy name is everything below `.localhost`, so it can be nested:
// `myapp` → myapp.localhost, `storybook.ui` → storybook.ui.localhost. A custom
// domain is the whole host, so it gets the full 253 to itself.
function validLabels(name: string, custom = false): boolean {
    const labels = name.split('.');
    const budget = custom ? 253 : 253 - SUFFIX.length;
    return name.length <= budget && labels.every((l) => LABEL_RE.test(l));
}

// Expand a leading ~ and resolve to an absolute path.
function expandPath(raw: unknown): string {
    let p = String(raw || '').trim();
    if (!p) return '';
    if (p === '~') p = HOME;
    else if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
    return path.resolve(p);
}

// `excluding` is the name of the proxy being edited, so keeping its own port
// doesn't read as a collision with itself — same as validateName below.
function validatePort(port: unknown, existing: Proxy[], excluding?: string): Validated<number> {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
        return { error: 'Port must be an integer between 1 and 65535.' };
    }
    if (value === 80 || value === 443) {
        return { error: 'Port 80 and 443 are used by nginx itself — pick your app’s port.' };
    }
    if (value === config.port) {
        return { error: `Port ${value} is used by dev.localhost itself.` };
    }
    // One port, one app. Two proxies pointing at the same one is a mistake
    // nothing downstream can show: nginx would send both domains to whichever
    // app is listening, so the second domain would look fine while serving the
    // first one's site.
    const clash = existing.find((p) => p.name !== excluding && p.port === value);
    if (clash) return { error: `Port ${value} is already used by "${proxyHost(clash)}".` };
    return { value };
}

// The optional app path. Empty is fine; if given it must be an existing dir.
function validateAppPath(raw: unknown): Validated<string | null> {
    const p = expandPath(raw);
    if (!p) return { value: null };
    try {
        if (!fs.statSync(p).isDirectory()) return { error: `Not a directory: ${p}` };
    } catch {
        return { error: `Path not found: ${p}` };
    }
    return { value: p };
}

// The name is the label below `.localhost` — or, with `custom`, the whole host.
// `excluding` is the current name of the proxy being renamed, so keeping it
// doesn't read as a collision with itself.
function validateName(
    raw: unknown,
    existing: Proxy[],
    wantCustom: boolean,
    excluding?: string,
): Validated<{ name: string; custom: boolean }> {
    // tidyHost, so pasting `https://myapp.test/` in the name field is read as
    // the domain rather than rejected as a malformed one.
    const typed = tidyHost(String(raw || ''));

    // A `.localhost` host is one of ours however it was typed. Stripping the
    // suffix here means "myapp.localhost" pasted into either mode of the field
    // lands on the same proxy as plain "myapp", instead of quietly creating a
    // custom domain that shadows it.
    const custom = wantCustom && !typed.endsWith(SUFFIX);
    const proxyName = custom ? typed : typed.replace(/\.localhost$/, '');

    if (!proxyName || !validLabels(proxyName, custom)) {
        return {
            error: custom
                ? 'Domain must be lowercase letters, numbers, dashes, and dots (e.g. myapp.test).'
                : 'Name must be lowercase letters, numbers, dashes, and dots (a valid subdomain).',
        };
    }
    // A single-label custom domain (`myapp`) has no TLD: it would collide with
    // machine names on the local network and can't be trusted to resolve.
    if (custom && !proxyName.includes('.')) {
        return { error: 'A custom domain needs at least two labels, e.g. myapp.test.' };
    }

    const host = custom ? proxyName : `${proxyName}${SUFFIX}`;
    if (RESERVED.has(proxyName) || host === 'localhost') {
        return { error: `"${host}" is reserved.` };
    }
    // Both are checked: the host is what nginx serves, and the name is what the
    // API addresses a proxy by, so neither may repeat.
    const clash = existing.find(
        (p) => p.name !== excluding && (p.name === proxyName || proxyHost(p) === host),
    );
    if (clash) return { error: `A proxy for "${proxyHost(clash)}" already exists.` };

    return { value: { name: proxyName, custom } };
}

/**
 * The dev command, which is a line for a shell and so is only checked for the
 * things that would make it one we can't run.
 *
 * The default is not stored: a proxy that says `npm run dev` and a proxy that
 * says nothing mean the same thing today, and only the second still means it if
 * that default ever changes. So an empty field and the default field are both
 * `null` here, and procs.ts fills it in when it runs.
 *
 * Nothing is escaped, because nothing here is interpolated — the string is one
 * argument to `$SHELL -lc`, exactly as a user typed it into a terminal. What is
 * rejected is a value that can't be a single command line at all: control
 * characters, and a length no real command reaches.
 */
function validateCommand(raw: unknown): Validated<string | null> {
    const cmd = String(raw ?? '').trim();
    if (!cmd || cmd === procs.DEFAULT_COMMAND) return { value: null };
    if (cmd.length > 300) return { error: 'That dev command is too long.' };
    // Control characters, newline included: this is one command line, and a
    // second line pasted into the field would run as a second command.
    if (/[\u0000-\u001f\u007f]/.test(cmd)) return { error: 'A dev command has to be a single line.' };
    return { value: cmd };
}

export const TITLE_MAX = 60;

/**
 * The display name. Trimmed, and empty means no title at all, so the field can be
 * left blank without storing anything. A title is shown as a label, not used as an
 * identifier, so the only rule beyond length is that it is one line.
 */
export function validateTitle(raw: unknown): Validated<string | null> {
    const title = String(raw ?? '').trim();
    if (!title) return { value: null };
    if (title.length > TITLE_MAX) return { error: `A title can be at most ${TITLE_MAX} characters.` };
    if (/[\u0000-\u001f\u007f]/.test(title)) return { error: 'A title has to be a single line.' };
    return { value: title };
}

export function validateProxy(
    { name, port, path: appPath, command, custom, title }: ProxyInput,
    existing: Proxy[],
): Validated<Proxy> {
    const nv = validateName(name, existing, custom === true);
    if (nv.error !== undefined) return { error: nv.error };
    const pv = validatePort(port, existing);
    if (pv.error !== undefined) return { error: pv.error };
    const av = validateAppPath(appPath);
    if (av.error !== undefined) return { error: av.error };
    const cv = validateCommand(command);
    if (cv.error !== undefined) return { error: cv.error };
    const tv = validateTitle(title);
    if (tv.error !== undefined) return { error: tv.error };
    const value: Proxy = { name: nv.value.name, port: pv.value };
    if (av.value) value.path = av.value;
    if (cv.value) value.command = cv.value;
    if (tv.value) value.title = tv.value;
    if (nv.value.custom) value.custom = true;
    return { value };
}

export function addProxy(input: ProxyInput): { ok: false; error: string } | { ok: true; proxy: Proxy } {
    const list = loadProxies();
    const v = validateProxy(input, list);
    if (v.error !== undefined) return { ok: false, error: v.error };
    list.push(v.value);
    saveProxies(list);
    return { ok: true, proxy: v.value };
}

// Edit an existing proxy: its name (the label below `.localhost`), port, app
// path and/or dev command. `name` in the URL identifies the proxy; an omitted
// name in the body keeps the current one. Reports whether anything nginx cares
// about changed, so the caller knows if a reload is needed.
export function updateProxy(
    name: string,
    { name: newName, port, path: appPath, command, custom, title }: ProxyInput,
):
    | { ok: false; error: string }
    | { ok: true; proxy: Proxy; previousName: string; previousHost: string; needsReload: boolean } {
    const proxyName = String(name || '').toLowerCase();
    const list = loadProxies();
    const idx = list.findIndex((p) => p.name === proxyName);
    if (idx === -1) return { ok: false, error: `No proxy named "${proxyName}".` };
    // An omitted `custom` keeps whatever the proxy already is, so a client that
    // only sends a new port can't silently turn a custom domain back into a
    // `.localhost` one.
    const wantCustom = custom === undefined ? Boolean(list[idx].custom) : custom === true;
    const nv = validateName(newName ?? proxyName, list, wantCustom, proxyName);
    if (nv.error !== undefined) return { ok: false, error: nv.error };
    const pv = validatePort(port, list, proxyName);
    if (pv.error !== undefined) return { ok: false, error: pv.error };
    const av = validateAppPath(appPath);
    if (av.error !== undefined) return { ok: false, error: av.error };
    const cv = validateCommand(command);
    if (cv.error !== undefined) return { ok: false, error: cv.error };
    // An omitted title keeps the one already stored, so a client that doesn't send it
    // (the revert call, say) can't wipe a title out. An empty one clears it.
    const tv = title === undefined ? { value: list[idx].title ?? null } : validateTitle(title);
    if (tv.error !== undefined) return { ok: false, error: tv.error };
    const next: Proxy = { name: nv.value.name, port: pv.value };
    if (av.value) next.path = av.value;
    if (cv.value) next.command = cv.value;
    if (tv.value) next.title = tv.value;
    if (nv.value.custom) next.custom = true;
    const previousHost = proxyHost(list[idx]);
    const renamed = proxyHost(next) !== previousHost;
    // A rename means a new server_name, a new conf file and a new cert host — all
    // of which apply() regenerates from the store, so it just needs running.
    const needsReload = renamed || list[idx].port !== pv.value;
    list[idx] = next;
    saveProxies(list);
    // A running dev server is keyed by the proxy's name, so a rename has to take
    // it along — otherwise the row shows Start while the port stays busy, and its
    // console entry is named after a proxy that no longer exists.
    if (next.name !== proxyName) procs.rename(proxyName, next.name);
    return { ok: true, proxy: next, previousName: proxyName, previousHost, needsReload };
}

// The removed proxy comes back so the caller can clean up what was keyed to its
// host — its /etc/hosts entry, in particular, which is gone from the store by
// the time anyone could look it up again.
export function removeProxy(name: string): { ok: false; error: string } | { ok: true; proxy: Proxy } {
    const proxyName = String(name || '').toLowerCase();
    const list = loadProxies();
    const removed = list.find((p) => p.name === proxyName);
    if (!removed) return { ok: false, error: `No proxy named "${proxyName}".` };
    saveProxies(list.filter((p) => p !== removed));
    // Its row is the only place its dev server could be stopped from, and the row
    // is what's going — left running it would hold the port with nothing left to
    // stop it from.
    procs.remove(proxyName, removed.port);
    return { ok: true, proxy: removed };
}

/**
 * A proxy with an app directory that is really there.
 *
 * The three ways starting can fail before anything is spawned — no such proxy,
 * no path set, path gone — asked once, since Start, Restart and Open all have to
 * ask them and all three said it slightly differently when they each did.
 */
function runnable(
    name: string,
): { ok: false; error: string } | { ok: true; proxy: Proxy & { path: string } } {
    const p = loadProxies().find((x) => x.name === String(name || '').toLowerCase());
    if (!p) return { ok: false, error: `No proxy named "${name}".` };
    if (!p.path) return { ok: false, error: 'No app path is set for this proxy — edit it to add one.' };
    try {
        if (!fs.statSync(p.path).isDirectory()) return { ok: false, error: `Path not found: ${p.path}` };
    } catch {
        return { ok: false, error: `Path not found: ${p.path}` };
    }
    return { ok: true, proxy: p as Proxy & { path: string } };
}

/**
 * Start a proxy's dev server — here, as a child of this server, rather than in a
 * Terminal window of its own.
 *
 * It used to write a `.command` file and hand it to LaunchServices, which put
 * the process out of reach: a Terminal window we couldn't read, couldn't signal,
 * and could only find again by looking for whatever held the port. Now it is
 * ours, and its output is a console away — see server/procs.ts, which owns
 * everything about how it is spawned.
 */
export function openDev(name: string) {
    const r = runnable(name);
    if (!r.ok) return r;
    return procs.start(target(r.proxy));
}

/** Stop it and start it again, with the wait in between that keeps the new one
 *  from landing on a port the old one hasn't let go of yet. */
export function restartDev(name: string) {
    const r = runnable(name);
    if (!r.ok) return Promise.resolve(r);
    return procs.restart(target(r.proxy));
}

/** The four things procs.ts needs, out of everything a proxy is. */
function target(p: Proxy & { path: string }): procs.Target {
    return { name: p.name, cwd: p.path, port: p.port, cmd: p.command };
}

// Open a proxy's app folder in VS Code — `code <app path>`, nothing else runs.
// The `code` shim is only on PATH once "Shell Command: Install 'code' command"
// has been run, so fall back to launching the app itself with the folder.
export function openCode(name: string) {
    const p = loadProxies().find((x) => x.name === String(name || '').toLowerCase());
    if (!p) return { ok: false, error: `No proxy named "${name}".` };
    if (!p.path) return { ok: false, error: 'No app path is set for this proxy — edit it to add one.' };
    try {
        if (!fs.statSync(p.path).isDirectory()) return { ok: false, error: `Path not found: ${p.path}` };
    } catch {
        return { ok: false, error: `Path not found: ${p.path}` };
    }
    const bin = which('code');
    const r = bin ? sh(bin, [p.path]) : sh('open', ['-a', 'Visual Studio Code', p.path]);
    if (!r.ok) {
        return {
            ok: false,
            error: r.out || 'Could not open VS Code. Is it installed?',
            path: p.path,
        };
    }
    return { ok: true, path: p.path };
}

// Stop a proxy's dev server: ours by signalling its process group, anyone else's
// by killing whatever holds the port — see procs.stop, which decides which.
export function stopDev(name: string) {
    const p = loadProxies().find((x) => x.name === String(name || '').toLowerCase());
    if (!p) return { ok: false, error: `No proxy named "${name}".` };
    return procs.stop(p.name, p.port);
}

/**
 * Open the native folder picker and return what was chosen.
 *
 * The browser cannot supply an absolute path — a `webkitdirectory` input gives
 * relative names and the File System Access API gives an opaque handle — and an
 * app path has to be absolute to `cd` into. So the picker runs here instead.
 *
 * `activate` (with no target) brings osascript's own process forward so the
 * dialog opens in front of the browser. It needs no Automation permission,
 * unlike telling another app to activate.
 * @param start - a path to open the dialog at, if it still exists
 */
export function chooseFolder(start?: unknown): {
    ok: boolean;
    path?: string;
    canceled?: boolean;
    error?: string;
} {
    const from = expandPath(start);
    const at = from && fs.existsSync(from) ? `default location (POSIX file ${JSON.stringify(from)})` : '';
    const script = `activate\nPOSIX path of (choose folder with prompt "Choose the app folder" ${at})`;
    const r = sh('osascript', ['-e', script]);

    if (r.ok) {
        // `choose folder` returns a trailing slash; the store keeps plain paths.
        const chosen = r.out.trim().replace(/\/+$/, '');
        return chosen ? { ok: true, path: chosen } : { ok: false, error: 'No folder was returned.' };
    }
    // Dismissing the dialog is a normal outcome, not a failure to report.
    if (/User canceled|-128/.test(r.out)) return { ok: true, canceled: true };
    return { ok: false, error: r.out || 'Could not open a folder picker.' };
}

// Reveal the ~/.dev.localhost config directory in Finder.
export function openConfigDir() {
    ensureDirs();
    const r = sh('open', [P.base]);
    return { ok: r.ok, path: P.base, error: r.ok ? undefined : r.out };
}

// Open a URL in the default browser.
export function openUrl(url: string): CmdResult {
    return sh('open', [url]);
}

// Lightweight status pushed over the WebSocket: nginx up? each dev server up?
//
// `dev` stays what it has always been — is something listening on that port —
// because that is what decides whether the domain answers, whoever started it.
// `procs` is the narrower question the console asks: which of them are ours.
export function liveStatus(): Live {
    const running = nginxBin() ? nginxRunning() : false;
    const ports = listeningPorts();
    // Before the summaries are taken, not after: a process that has been silent
    // on its port since long before this tick has already ended, and the push is
    // the one place that finds out — see reap.
    procs.reap(ports);
    const dev: Record<string, boolean> = {};
    for (const p of loadProxies()) dev[p.name] = ports.has(Number(p.port));
    return { type: 'status', rev: revision(), nginxRunning: running, dev, procs: procs.summaries() };
}

// ---------------------------------------------------------------- state snapshot

// Annotated rather than inferred, so the shape the API promises and the shape
// this builds are checked against each other at compile time — that agreement is
// the only reason src/shared/types.ts exists.
export function state(): State {
    const bin = nginxBin();
    const running = bin ? nginxRunning() : false;
    const ports = listeningPorts();
    const hosts = hostsInfo();
    const resolved = new Set(hosts.entries);
    const managed = new Set(hosts.managed);
    const proxies = loadProxies().map((p) => {
        const host = proxyHost(p);
        // "provisioned" = TLS is actually being served for this host right now:
        // nginx is up, its config includes the proxy, and the cert covers the host.
        const provisioned = running && confExists(host) && hostCovered(host);
        return {
            ...p,
            host,
            provisioned,
            url: `${provisioned ? 'https' : 'http'}://${host}`,
            devRunning: ports.has(Number(p.port)),
            // Does anything point this host at loopback, and did we put it there?
            hostsEntry: resolved.has(host),
            hostsManaged: managed.has(host),
            // A `.localhost` name resolves on its own; anything else is dead in
            // the browser until /etc/hosts says otherwise.
            needsHosts: !host.endsWith(SUFFIX) && !resolved.has(host),
        };
    });
    return {
        proxies,
        nginx: {
            installed: Boolean(bin),
            bin,
            version: nginxVersion(bin),
            running,
            installCmd: 'brew install nginx',
        },
        cert: certInfo(),
        baseDir: P.base,
    };
}
