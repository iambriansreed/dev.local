#!/usr/bin/env node
// A stand-in for the dev.localhost server, for demo mode: a canned /api and a /ws push, with no
// nginx, no sudo and no dev servers. The apps are the samples in .scripts/dev.proxies.json.
// Start, Stop, the nginx controls and the proxy edits change the canned state, so the menu and
// the Settings window respond the way they would for real. Node built-ins only.
// Usage: fake-server.mjs <port>
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.argv[2] || 7979);
let rev = 1;

const app = (name, port, host, title, extra = {}) => ({
    name, port, host, title, provisioned: true, url: `https://${host}`, devRunning: false,
    path: `/Users/demo/Projects/${name}`, hostsEntry: !host.endsWith('.localhost'), hostsManaged: !host.endsWith('.localhost'),
    needsHosts: false, ...extra,
});

// The sample apps `npm run dev` also uses, as stored; the running ones are picked here.
const RUNNING = new Set(['storefront', 'app.northwind.test']);
const stored = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../../.scripts/dev.proxies.json'), 'utf8'));

const state = {
    proxies: stored.map(({ name, port, title, ...rest }) => {
        const host = rest.custom ? name : `${name}.localhost`;
        return app(name, port, host, title, { path: undefined, ...rest, devRunning: RUNNING.has(name) });
    }),
    nginx: { installed: true, bin: '/opt/homebrew/bin/nginx', version: '1.29.1', running: true, installCmd: 'brew install nginx' },
    cert: { exists: true, method: 'mkcert', version: '1.4.4', mkcertAvailable: true, hosts: ['localhost'], trustCmd: null },
    baseDir: '/Users/demo/.dev.localhost',
};
// Storefront was started by the server (Log, and output to show); the others were started by hand.
const ours = new Map([['storefront', { startedAt: Date.now() - 60_000, log: '\x1b[2m~/Projects/storefront $\x1b[0m \x1b[1mnpm run dev\x1b[0m\n\n> storefront@2.4.0 dev\n> vite\n\n  \x1b[32mVITE v7.1.3\x1b[0m  ready in \x1b[1m412\x1b[0m ms\n\n  \x1b[32m➜\x1b[0m  Local:   http://localhost:3000/\n' }]]);

const procs = () => [...ours].map(([name, p]) => ({ name, running: Boolean(state.proxies.find((x) => x.name === name)?.devRunning), cmd: 'npm run dev', cwd: `/Users/demo/Projects/${name}`, startedAt: p.startedAt, bytes: p.log.length }));
const live = () => ({
    type: 'status', rev, nginxRunning: state.nginx.running,
    dev: Object.fromEntries(state.proxies.map((p) => [p.name, Boolean(p.devRunning)])),
    procs: procs().map((p) => ({ name: p.name, running: p.running })),
});

function json(res, body, status = 200) {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    });
}
const ok = (extra = {}) => ({ ok: true, applied: { ok: true, step: 'none' }, hosts: { ok: true, changed: false }, state, ...extra });

async function api(req, res, pathname) {
    const method = req.method;
    const named = pathname.match(/^\/api\/proxies\/([^/]+)(?:\/(\w+))?$/);
    const find = (name) => state.proxies.find((p) => p.name === decodeURIComponent(name));
    const procNamed = pathname.match(/^\/api\/procs\/([^/]+)\/(\w+)$/);

    if (method === 'GET' && pathname === '/api/state') return json(res, state);
    if (method === 'GET' && pathname === '/api/procs') return json(res, { ok: true, procs: procs() });
    if (method === 'GET' && procNamed?.[2] === 'log') {
        const p = ours.get(decodeURIComponent(procNamed[1]));
        return p ? json(res, { ok: true, name: procNamed[1], text: p.log }) : json(res, { ok: false, error: 'Nothing started.' }, 404);
    }
    if (method === 'POST' && procNamed?.[2] === 'clear') { const p = ours.get(decodeURIComponent(procNamed[1])); if (p) p.log = ''; return json(res, { ok: true, procs: procs() }); }
    if (method === 'GET' && pathname === '/api/hosts') return json(res, { path: '/etc/hosts', ok: true, original: '127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1\tlocalhost', managed: '127.0.0.1\tapp.northwind.test\n127.0.0.1\tapi.northwind.test' });
    if (method === 'POST' && pathname === '/api/nginx/start') state.nginx.running = true;
    else if (method === 'POST' && pathname === '/api/nginx/stop') state.nginx.running = false;
    else if (method === 'POST' && (pathname === '/api/nginx/reload' || pathname === '/api/apply' || pathname === '/api/cert' || pathname === '/api/config/open')) {}
    // Demo mode never touches /etc/hosts: Fix hosts entry marks every custom domain as resolved.
    else if (method === 'POST' && pathname === '/api/hosts/fix') { for (const p of state.proxies) if (p.needsHosts) { p.hostsEntry = true; p.hostsManaged = true; p.needsHosts = false; } rev++; return json(res, { ok: true, changed: false }); }
    else if (named?.[2] === 'dev' || named?.[2] === 'restart') {
        const p = find(named[1]);
        if (p) { p.devRunning = true; if (!ours.has(p.name)) ours.set(p.name, { startedAt: Date.now(), log: `\x1b[2m~/Projects/${p.name} $\x1b[0m \x1b[1mnpm run dev\x1b[0m\n` }); }
        return json(res, { ok: true, pid: 4242, cmd: 'npm run dev', path: p?.path });
    } else if (named?.[2] === 'stop') { const p = find(named[1]); if (p) p.devRunning = false; return json(res, { ok: true, stopped: true }); }
    else if (named?.[2] === 'code') return json(res, { ok: true, path: find(named[1])?.path });
    else if (method === 'POST' && pathname === '/api/proxies') {
        const b = await readBody(req);
        const typed = String(b.name || 'new').toLowerCase().replace(/\.localhost$/, '');
        const custom = typed.includes('.') ; const host = custom ? typed : `${typed}.localhost`;
        if (state.proxies.some((p) => p.host === host)) return json(res, { ok: false, error: `A proxy for "${host}" already exists.` }, 400);
        const p = app(custom ? host : typed, Number(b.port) || 3000, host, b.title || undefined, { path: b.path || undefined, custom: custom || undefined, command: b.command && b.command !== 'npm run dev' ? b.command : undefined });
        state.proxies.push(p); rev++;
        return json(res, ok({ proxy: p }));
    } else if (method === 'PUT' && named && !named[2]) {
        const b = await readBody(req); const p = find(named[1]);
        if (!p) return json(res, { ok: false, error: 'No such proxy.' }, 400);
        const typed = String(b.name || p.host).toLowerCase().replace(/\.localhost$/, '');
        const custom = typed.includes('.'); const previousHost = p.host;
        Object.assign(p, { title: b.title || undefined, port: Number(b.port) || p.port, path: b.path || undefined, command: b.command && b.command !== 'npm run dev' ? b.command : undefined, host: custom ? typed : `${typed}.localhost`, name: custom ? typed : typed, custom: custom || undefined, url: `https://${custom ? typed : `${typed}.localhost`}` });
        rev++;
        return json(res, ok({ proxy: p, previousHost }));
    } else if (method === 'DELETE' && named && !named[2]) {
        state.proxies = state.proxies.filter((p) => p.name !== decodeURIComponent(named[1])); rev++;
    } else if (method === 'POST' && pathname === '/api/browse') return json(res, { ok: true, path: '/Users/demo/Projects/picked' });
    return json(res, ok());
}

const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname.startsWith('/api/')) {
        api(req, res, pathname).catch(() => json(res, { ok: false, error: 'demo server error' }, 500));
        return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('demo server: /api/ only');
});

// One unmasked text frame (server to client frames are never masked), any length.
function frame(text) {
    const payload = Buffer.from(text); const n = payload.length; let header;
    if (n < 126) header = Buffer.from([0x81, n]);
    else if (n < 65536) header = Buffer.from([0x81, 126, n >> 8, n & 0xff]);
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(n), 2); }
    return Buffer.concat([header, payload]);
}
// A masked text frame from the client (what it wants to watch), or null while incomplete.
function readFrame(buf) {
    if (buf.length < 2) return null;
    let len = buf[1] & 0x7f, offset = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
    if (buf.length < offset + 4 + len) return null;
    const key = buf.subarray(offset, offset + 4); const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    return { opcode: buf[0] & 0x0f, payload, size: offset + 4 + len };
}

server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (obj) => { try { socket.write(frame(JSON.stringify(obj))); } catch { clearInterval(timer); } };
    let watching = null, pending = Buffer.alloc(0);
    const timer = setInterval(() => {
        send(live());
        // A line of output every tick for the watched process, so the console moves.
        if (watching && ours.has(watching)) { const line = `\x1b[90m${new Date().toLocaleTimeString()}\x1b[0m [hmr] page changed, rebuilding\n`; ours.get(watching).log += line; send({ type: 'log', name: watching, text: line }); }
    }, 2000);
    send(live());
    socket.on('data', (d) => {
        pending = Buffer.concat([pending, d]);
        for (;;) {
            const f = readFrame(pending); if (!f) return; pending = pending.subarray(f.size);
            if (f.opcode === 0x8) return socket.destroy();
            if (f.opcode !== 0x1) continue;
            try { const msg = JSON.parse(f.payload.toString('utf8')); if ('watch' in msg) { watching = typeof msg.watch === 'string' ? msg.watch : null; if (watching && ours.has(watching)) send({ type: 'log', name: watching, text: ours.get(watching).log, reset: true }); } } catch {}
        }
    });
    socket.on('error', () => clearInterval(timer));
    socket.on('close', () => clearInterval(timer));
});

server.listen(port, '127.0.0.1', () => console.log(`demo server on http://127.0.0.1:${port}`));
