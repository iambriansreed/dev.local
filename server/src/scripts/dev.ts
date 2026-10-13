// `npm run dev:server` — tsc compiles and watches, the server runs from its output and is
// restarted whenever that output changes.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// This file lives at src/scripts/, so the server folder is two levels up.
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BIN = path.resolve(ROOT, '..', 'node_modules', '.bin');
const SERVER = path.join(ROOT, 'dist', 'server', 'index.js');
// The server's API socket, as nginx.ts works it out (it cannot be imported from here: this
// runs before the first compile)
const SOCKET = process.env.DEV_LOCALHOST_SOCKET || path.join(os.homedir(), '.dev.localhost', 'server.sock');
const color = { cyan: '\x1b[36m', gray: '\x1b[90m', red: '\x1b[31m', reset: '\x1b[0m' };

let tsc: ChildProcess | null = null;
let server: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let restarting = false;
let stopping = false;

void main();

async function main(): Promise<void> {
    process.on('SIGINT', () => void shutdown(0));
    process.on('SIGTERM', () => void shutdown(0));

    // A server already on the socket would make this one exit at once; refuse, and say so.
    if (await canConnect()) {
        log(`a dev.localhost server is already listening on ${SOCKET}. Quit the app (or stop that server) first.`, color.red);
        return void shutdown(1);
    }

    // The repo's tsc, not whichever is on PATH: a global one can be older than the pinned one.
    tsc = spawn(path.join(BIN, 'tsc'), ['-w', '-p', 'tsconfig.json', '--preserveWatchOutput', '--pretty'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    label(tsc);
    tsc.on('error', (err) => {
        log(`could not run tsc — ${err.message}`, color.red);
        void shutdown(1);
    });
    tsc.on('exit', (code, signal) => {
        tsc = null;
        if (stopping) return;
        log('tsc stopped — shutting down.');
        void shutdown(signal ? 1 : (code ?? 0));
    });

    // The first build has to finish before there is a server to run.
    const deadline = Date.now() + 120_000;
    while (!stopping && !fs.existsSync(SERVER)) {
        if (Date.now() > deadline) {
            log(`${path.relative(ROOT, SERVER)} was never built — see the errors above.`, color.red);
            return void shutdown(1);
        }
        await sleep(200);
    }
    if (stopping) return;

    startServer();
    // tsc is incremental: a write here means server code changed and compiled.
    fs.watch(path.dirname(SERVER), (_event, file) => {
        if (file && !file.endsWith('.js')) return;
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(() => void restartServer(), 200);
    }).on('error', (err) => log(`stopped watching server rebuilds — ${err.message}`, color.red));
}

function canConnect(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(SOCKET);
        const done = (ok: boolean) => {
            socket.destroy();
            resolve(ok);
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
        socket.setTimeout(1000, () => done(false));
    });
}

function startServer(): void {
    // stdio inherited: the server's output lands in this terminal.
    const child = spawn(process.execPath, [SERVER], {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, DEV_LOCALHOST_ROOT: ROOT },
    });
    server = child;
    child.on('error', (err) => log(`could not start the server — ${err.message}`, color.red));
    child.on('exit', (code, signal) => {
        if (server === child) server = null;
        if (stopping || restarting) return;
        log(`server exited (${signal ?? code}) — save a file under src/server/ to restart it.`);
    });
}

async function restartServer(): Promise<void> {
    if (stopping) return;
    if (restarting) {
        restartTimer = setTimeout(() => void restartServer(), 200);
        return;
    }
    restarting = true;
    log('server rebuilt — restarting.');
    const old = server;
    server = null;
    await stopChild(old, 'SIGTERM');
    if (!stopping) startServer();
    restarting = false;
}

async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    await Promise.all([stopChild(server, 'SIGTERM'), stopChild(tsc, 'SIGINT')]);
    process.exit(code);
}

function stopChild(child: ChildProcess | null, signal: NodeJS.Signals): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
        const hardKill = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.once('exit', () => {
            clearTimeout(hardKill);
            resolve();
        });
        child.kill(signal);
    });
}

// Prefix tsc's output so it's distinguishable from the server's.
function label(child: ChildProcess): void {
    const prefix = `${color.gray}[tsc]${color.reset} `;
    const write = (out: NodeJS.WritableStream) => (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) if (line.trim()) out.write(`${prefix}${line}\n`);
    };
    child.stdout?.on('data', write(process.stdout));
    child.stderr?.on('data', write(process.stderr));
}

function log(msg: string, msgColor = color.cyan): void {
    console.log(`${color.gray}[dev]${color.reset} ${msgColor}${msg}${color.reset}`);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
