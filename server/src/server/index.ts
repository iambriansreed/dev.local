// dev.localhost — management server: a small JSON API, a live socket, nginx and the dev
// servers. The menu bar app is its only client. Zero dependencies; Node built-ins only.
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as nginx from './nginx.ts';
import * as procs from './procs.ts';

const PORT = nginx.config.port;
const HOST = '127.0.0.1'; // localhost only — never expose this to the network.

// An optional shell command to run alongside the server, started once nginx is up.
const DEV_CMD = (process.argv[2] || '').trim();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c: Buffer | string) => {
            raw += c;
            if (raw.length > 1e6) req.destroy(); // guard
        });
        req.on('end', () => {
            if (!raw) return resolve({});
            try {
                resolve(JSON.parse(raw) as Record<string, unknown>);
            } catch {
                resolve({});
            }
        });
    });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { pathname } = url;
    const method = req.method;

    // GET /api/state
    if (method === 'GET' && pathname === '/api/state') {
        return sendJson(res, 200, nginx.state());
    }

    // POST /api/proxies  { name, port, path, custom }
    if (method === 'POST' && pathname === '/api/proxies') {
        const body = await readBody(req);
        const add = nginx.addProxy(body);
        if (!add.ok) return sendJson(res, 400, { ok: false, error: add.error });
        // `host` is included because the server has the last word on it: a
        // custom domain typed out as foo.localhost is stored as an ordinary one.
        const proxy = { ...add.proxy, host: nginx.proxyHost(add.proxy) };
        // A custom domain also needs an /etc/hosts entry. That is never written from
        // here: the row shows Fix hosts entry, which explains itself in Terminal.
        const applied = nginx.apply();
        return sendJson(res, 200, { ok: applied.ok, applied, proxy, state: nginx.state() });
    }

    // POST /api/proxies/:name/dev — open VS Code + `npm run dev` in a Terminal
    if (method === 'POST' && pathname.startsWith('/api/proxies/') && pathname.endsWith('/dev')) {
        const name = decodeURIComponent(pathname.slice('/api/proxies/'.length, -'/dev'.length));
        return sendJson(res, 200, nginx.openDev(name));
    }

    // POST /api/proxies/:name/code — open the app folder in VS Code
    if (method === 'POST' && pathname.startsWith('/api/proxies/') && pathname.endsWith('/code')) {
        const name = decodeURIComponent(pathname.slice('/api/proxies/'.length, -'/code'.length));
        return sendJson(res, 200, nginx.openCode(name));
    }

    // POST /api/proxies/:name/stop — stop that proxy's dev server
    if (method === 'POST' && pathname.startsWith('/api/proxies/') && pathname.endsWith('/stop')) {
        const name = decodeURIComponent(pathname.slice('/api/proxies/'.length, -'/stop'.length));
        return sendJson(res, 200, nginx.stopDev(name));
    }

    // POST /api/proxies/:name/restart — stop it, wait for the port, start it again
    if (method === 'POST' && pathname.startsWith('/api/proxies/') && pathname.endsWith('/restart')) {
        const name = decodeURIComponent(pathname.slice('/api/proxies/'.length, -'/restart'.length));
        return sendJson(res, 200, await nginx.restartDev(name));
    }

    // GET /api/procs — every dev server we started, running or finished.
    // The console's dropdown; the live push carries the same list in summary.
    if (method === 'GET' && pathname === '/api/procs') {
        return sendJson(res, 200, { ok: true, procs: procs.list() });
    }

    // GET /api/procs/:name/log — the whole buffer for one of them.
    //
    // The console reads its output over the WebSocket, which sends this same text
    // on subscribing and streams what follows. This is the way in when that
    // socket is down — a console that goes blank because the connection dropped
    // is a console that looks like it lost the output.
    if (method === 'GET' && pathname.startsWith('/api/procs/') && pathname.endsWith('/log')) {
        const name = decodeURIComponent(pathname.slice('/api/procs/'.length, -'/log'.length));
        const text = procs.log(name);
        if (text === null) return sendJson(res, 404, { ok: false, error: `Nothing started for "${name}".` });
        return sendJson(res, 200, { ok: true, name, text, proc: procs.get(name) });
    }

    // POST /api/procs/:name/clear — empty that buffer (see procs.clear)
    if (method === 'POST' && pathname.startsWith('/api/procs/') && pathname.endsWith('/clear')) {
        const name = decodeURIComponent(pathname.slice('/api/procs/'.length, -'/clear'.length));
        return sendJson(res, 200, { ok: procs.clear(name), procs: procs.list() });
    }

    // PUT /api/proxies/:name — edit an existing proxy's name / port / app path
    if (method === 'PUT' && pathname.startsWith('/api/proxies/')) {
        const name = decodeURIComponent(pathname.slice('/api/proxies/'.length));
        const body = await readBody(req);
        const upd = nginx.updateProxy(name, body);
        if (!upd.ok) return sendJson(res, 400, { ok: false, error: upd.error });
        const host = nginx.proxyHost(upd.proxy);
        // Only reload nginx when something it serves changed (a new name or port).
        // An app-path-only edit never touches the generated config.
        const applied: nginx.ApplyResult = upd.needsReload ? nginx.apply() : { ok: true, step: 'none' };
        return sendJson(res, 200, {
            ok: applied.ok,
            applied,
            proxy: { ...upd.proxy, host },
            previousHost: upd.previousHost,
            state: nginx.state(),
        });
    }

    // DELETE /api/proxies/:name
    if (method === 'DELETE' && pathname.startsWith('/api/proxies/')) {
        const name = decodeURIComponent(pathname.slice('/api/proxies/'.length));
        const rm = nginx.removeProxy(name);
        if (!rm.ok) return sendJson(res, 404, { ok: false, error: rm.error });
        const applied = nginx.apply();
        // Its /etc/hosts entry, if any, goes the next time Fix hosts entry runs.
        return sendJson(res, 200, { ok: applied.ok, applied, state: nginx.state() });
    }

    // GET /api/hosts — the file itself, split into what's ours and what isn't.
    // Read on demand rather than pushed with the state: it's for one panel, and
    // that panel is shut nearly all the time.
    if (method === 'GET' && pathname === '/api/hosts') {
        return sendJson(res, 200, nginx.hostsFile());
    }

    // POST /api/hosts/fix — stage the new /etc/hosts and the Terminal script that
    // explains it and copies it into place with sudo. The server never runs sudo; the
    // app opens `script`, and the hosts watcher picks the change up once it lands.
    if (method === 'POST' && pathname === '/api/hosts/fix') {
        const r = nginx.prepareHostsFix();
        return sendJson(res, r.ok ? 200 : 400, r);
    }

    // POST /api/apply — regenerate config + reload/start nginx
    if (method === 'POST' && pathname === '/api/apply') {
        return sendJson(res, 200, { ...nginx.apply(), state: nginx.state() });
    }

    // POST /api/nginx/(start|stop|reload)
    if (method === 'POST' && pathname === '/api/nginx/start') {
        return sendJson(res, 200, { ...nginx.apply(), state: nginx.state() });
    }
    if (method === 'POST' && pathname === '/api/nginx/stop') {
        return sendJson(res, 200, { ...nginx.stopNginx(), state: nginx.state() });
    }
    if (method === 'POST' && pathname === '/api/nginx/reload') {
        return sendJson(res, 200, { ...nginx.apply(), state: nginx.state() });
    }

    // POST /api/cert — (re)provision the cert to cover all current hosts
    if (method === 'POST' && pathname === '/api/cert') {
        return sendJson(res, 200, { ...nginx.provisionCert(), state: nginx.state() });
    }

    // POST /api/config/open — reveal ~/.dev.localhost in Finder
    if (method === 'POST' && pathname === '/api/config/open') {
        return sendJson(res, 200, nginx.openConfigDir());
    }

    // POST /api/browse  { start } — native folder picker for the app-path field
    if (method === 'POST' && pathname === '/api/browse') {
        const body = await readBody(req);
        return sendJson(res, 200, nginx.chooseFolder(body?.start));
    }

    return sendJson(res, 404, { ok: false, error: 'Unknown endpoint' });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
        handleApi(req, res, url).catch((err: unknown) => {
            sendJson(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
        });
        return;
    }

    // There is no page any more: Settings is the menu bar app's own window.
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dev.localhost server. The API is under /api/.');
});

// --- minimal WebSocket at /ws ----------------------------------------------
// The menu bar app keeps a socket open (straight to 127.0.0.1, not through nginx) so
// we can push "is each dev server running?" often, live — and, while a console
// is open, that process's output as it arrives. No dependency; hand-rolled per
// RFC 6455.
//
// It reads as well as writes now. The only thing a client ever says is which
// process it wants the output of, but that one message is what keeps a console
// from costing anything when it's shut — which is nearly always.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsFrame(str: string): Buffer {
    const payload = Buffer.from(str, 'utf8');
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
        header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
        header = Buffer.from([0x81, 126, (len >> 8) & 0xff, len & 0xff]);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
        header.writeUInt32BE(len >>> 0, 6);
    }
    return Buffer.concat([header, payload]);
}

/**
 * One decoded frame, and how much of the buffer it took.
 *
 * `null` means "not all here yet" — a frame can arrive split across TCP reads,
 * and the difference between an incomplete frame and a malformed one is only
 * whether more bytes are coming.
 */
type WsFrame = { opcode: number; payload: Buffer; size: number };

/**
 * Read one frame off the front of `buf`, if a whole one is there.
 *
 * Client→server frames are always masked (RFC 6455 §5.3) — a browser will not
 * send an unmasked one — so this unmasks unconditionally and refuses a frame
 * that arrives without a key rather than reading the mask as payload.
 */
function readFrame(buf: Buffer): WsFrame | null {
    if (buf.length < 2) return null;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
        if (buf.length < 4) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buf.length < 10) return null;
        const big = buf.readBigUInt64BE(2);
        // Nothing this end of the socket sends anything near this big, so a
        // frame that claims to is a fault rather than a large message.
        if (big > 1n << 20n) return { opcode: 0x8, payload: Buffer.alloc(0), size: buf.length };
        len = Number(big);
        offset = 10;
    }
    if (!masked) return { opcode: 0x8, payload: Buffer.alloc(0), size: buf.length };
    if (buf.length < offset + 4 + len) return null;
    const key = buf.subarray(offset, offset + 4);
    const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    return { opcode: buf[0] & 0x0f, payload, size: offset + 4 + len };
}

server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    const key = req.headers['sec-websocket-key'];
    if (pathname !== '/ws' || !key) {
        socket.destroy();
        return;
    }
    const accept = crypto
        .createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let alive = true;
    // Which process's output this socket wants, if any. Null is the usual state:
    // every client holds a socket open, and only one showing an app's output in
    // Settings is being sent it.
    let watching: string | null = null;

    const send = (data: unknown) => {
        if (!alive) return;
        try {
            socket.write(wsFrame(JSON.stringify(data)));
        } catch {
            cleanup();
        }
    };

    // Output as it arrives, for the one process this socket asked for. Registered
    // for the life of the socket rather than per subscription, so there is one
    // thing to unregister and it happens in exactly one place.
    const unsubscribe = procs.subscribe((frame) => {
        if (frame.name === watching) send(frame);
    });

    const cleanup = () => {
        if (!alive) return;
        alive = false;
        clearInterval(timer);
        unsubscribe();
        socket.destroy();
    };

    const push = () => send(nginx.liveStatus());
    const timer = setInterval(push, 2000);

    /**
     * Start (or stop) watching a process.
     *
     * Subscribing replies with everything buffered so far, marked `reset` — the
     * console is showing whatever was there before, and this is the frame that
     * replaces it rather than adding to it. What follows is appended.
     */
    const watch = (name: string | null) => {
        watching = name;
        if (!name) return;
        send({ type: 'log', name, text: procs.log(name) ?? '', reset: true });
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);

    // Frames arrive split and coalesced by TCP, so they are read out of a
    // running buffer rather than assumed to be one per event.
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (buf: Buffer) => {
        pending = pending.length ? Buffer.concat([pending, buf]) : Buffer.from(buf);
        for (;;) {
            const frame = readFrame(pending);
            if (!frame) return; // the rest is still on its way
            pending = pending.subarray(frame.size);
            if (frame.opcode === 0x8) return cleanup(); // close
            if (frame.opcode === 0x9) {
                // Pong: same payload, opcode 0xA. Browsers don't ping, but a
                // proxy in front of us might. Truncated to the 125 bytes a
                // control frame is allowed, so a client that sent more can't
                // make us write a length byte that means something else.
                const body = frame.payload.subarray(0, 125);
                socket.write(Buffer.concat([Buffer.from([0x8a, body.length]), body]));
                continue;
            }
            if (frame.opcode !== 0x1) continue; // text is all we speak
            try {
                const msg = JSON.parse(frame.payload.toString('utf8')) as { watch?: unknown };
                if ('watch' in msg) watch(typeof msg.watch === 'string' ? msg.watch : null);
            } catch {
                /* a frame we can't read is one we ignore */
            }
        }
    });

    push(); // send immediately so the UI is correct on connect
});

// Every dev server we started goes down with us.
//
// They are in process groups of their own (that is what lets us signal a whole
// `npm run dev` tree rather than the shell in front of it), which also means a
// Ctrl-C in this terminal doesn't reach them — they would be left holding their
// ports with nothing left to stop them from. So each of the three ways this
// process ends says so.
//
// Registered here rather than inside procs.ts: a module that installs signal
// handlers on import does it wherever it is imported, and nginx.ts and the
// tests import it too.
process.on('exit', procs.killAll);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        procs.killAll();
        process.exit(0);
    });
}

// Hand the terminal over to the passed-in command (see DEV_CMD). stdio is
// inherited so its output — and any live-reload logs — appear right here.
function runDevCmd(): void {
    if (!DEV_CMD) return;
    console.log(`  ▸ ${DEV_CMD}`);
    console.log('');
    const child = spawn('/bin/sh', ['-c', DEV_CMD], { stdio: 'inherit' });
    child.on('error', (err: Error) => {
        console.log(`  ⚠ could not run "${DEV_CMD}" — ${err.message}`);
    });
    // That command is the point of this session: when it stops, so do we.
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        process.exit(signal ? 1 : (code ?? 0));
    });
    // Ctrl-C reaches both (same process group), but a signal sent to this process
    // alone shouldn't leave the dev server orphaned.
    process.on('exit', () => {
        child.kill();
    });

    process.on('SIGINT', () => {
        child.kill('SIGINT');
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        child.kill('SIGTERM');
        process.exit(0);
    });
}

// A second server on the same port (the menu bar app attaches to one a terminal already
// started) is not a crash: say so in one line, and exit with a code the app can read.
server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`  Port ${PORT} is already in use. A dev.localhost server is probably running.`);
        process.exit(2);
    }
    console.log(`  Could not listen on ${HOST}:${PORT} — ${err.message}`);
    process.exit(1);
});

server.listen(PORT, HOST, () => {
    console.log('');
    console.log(`  dev.localhost server on http://${HOST}:${PORT}`);

    if (!nginx.nginxBin()) {
        console.log('  nginx is not installed — install it, then restart:');
        console.log('      brew install nginx');
        console.log('');
        nginx.watchHostsFile();
        runDevCmd();
        return;
    }

    // Start nginx at once, so every app's https domain answers. nginx runs as the user, so
    // this never asks for a password.
    const applied = nginx.apply();
    if (applied.ok) {
        console.log('  ▸ nginx is serving every app over https');
    } else {
        console.log(`  ⚠ nginx did not start (step: ${applied.step}).`);
        // nginx's own stderr is captured, not inherited — print it or the reason
        // for the failure is lost entirely.
        for (const line of (applied.out || '').split('\n')) {
            if (line.trim()) console.log(`    ${line}`);
        }
        console.log('  Fix the cause, then Start nginx again from the menu.');
    }
    console.log('');

    nginx.watchHostsFile();
    runDevCmd();
});
