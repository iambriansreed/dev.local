#!/usr/bin/env -S npx --no tsx
/**
 * @file Runs everything together, as `npm run dev`, the way an installed app runs: the menu bar
 * app starts the server itself (login-shell PATH, output in ~/.dev.localhost/logs/server.log,
 * which is tailed here), against your real apps through ~/.dev.localhost and nginx. This script
 * only compiles the server (`tsc -w`) and restarts the app, and with it the server, whenever the
 * compiled server or a file under `app/` changes. The website's dev server runs alongside. The
 * demo with the sample apps (screenshots, no nginx) is app/scripts/demo.sh on its own.
 *
 * Both children start in their **own process groups** (`detached: true`) and are killed by
 * group on the way out. `app/scripts/dev-app.sh` builds, then `exec`s the real binary, so a plain
 * `kill` aimed at the pid we know can leave the app running and holding its single-instance
 * lock. Stopping the app stops the server it started, so a restart is a clean cold start.
 *
 * This is what `npm run dev` calls, so it must never call `npm run dev` back.
 *
 * @module dev
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { placeMarketingFirst } from './marketing-site';

process.chdir(path.join(import.meta.dirname, '..'));

/** A child started in its own process group. */
type Child = {
    /** For messages. */
    name: string;
    /** The spawned process. */
    process: ChildProcess;
};

const children: Child[] = [];

/** Guards against re-entering {@link stopAll} from a child's own exit handler. */
let stopping = false;

/**
 * Signals a child's whole process group. Failures are ignored: the child has usually exited
 * already, and its group no longer exists.
 *
 * @param child
 * @param signal
 */
function signalGroup(child: Child, signal: NodeJS.Signals): void {
    if (child.process.pid === undefined) return;
    try {
        // Negative pid: the group, not just the leader
        process.kill(-child.process.pid, signal);
    } catch {
        // already gone
    }
}

/**
 * Signals every child's process group, then exits.
 *
 * @param code Exit code for this process.
 */
function stopAll(code: number): never {
    stopping = true;
    for (const child of children) signalGroup(child, 'SIGTERM');
    process.exit(code);
}

/**
 * Starts a command in its own process group, wired to this terminal.
 *
 * @param name A label for messages.
 * @param command The executable to run.
 * @param args Its arguments.
 * @param options.cwd Directory to run in, relative to the repository root.
 * @param options.onExit
 *   Called when the child exits; returning true means it was handled and the session carries on.
 *   Otherwise the first child to stop takes the session with it.
 */
function start(
    name: string,
    command: string,
    args: string[],
    {
        cwd,
        onExit,
    }: { cwd?: string; onExit?: (code: number | null, signal: NodeJS.Signals | null) => boolean } = {}
): Child {
    const child: Child = { name, process: spawn(command, args, { cwd, stdio: 'inherit', detached: true }) };
    child.process.on('exit', (code, signal) => {
        const index = children.indexOf(child);
        if (index !== -1) children.splice(index, 1);
        if (stopping || onExit?.(code, signal)) return;
        // Ctrl+C in either half, or a crash, ends the whole thing rather than leaving one
        // running unattended.
        const how = signal ? `signal ${signal}` : `code ${code}`;
        console.error(`\n${name} exited (${how}); stopping.`);
        stopAll(typeof code === 'number' ? code : 1);
    });
    children.push(child);
    return child;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => stopAll(signal === 'SIGINT' ? 130 : 143));
}

// MARK: The menu bar app, restarted on changes under app/

let app: Child | undefined;

/** True from asking the running app to stop until the new one has been started. */
let restarting = false;

/**
 * Starts `dev-app.sh` (build, then run). A failed build or a crash leaves the session running,
 * waiting for the next change to try again; quitting the app from its own menu (exit code 0)
 * still ends the session.
 */
function startApp(): void {
    app = start('the menu bar app', 'app/scripts/dev-app.sh', [], {
        onExit(code, signal) {
            app = undefined;
            if (restarting) return true;
            if (code === 0) return false;
            const how = signal ? `signal ${signal}` : `code ${code}`;
            console.error(`\nthe menu bar app exited (${how}); waiting for a change under app/ to try again.`);
            return true;
        },
    });
}

/**
 * Stops the running app (if any), waits for it to exit so its instance lock is free, then
 * starts it again. A change that arrives mid-restart needs nothing more: the new run builds
 * after it.
 */
function restartApp(): void {
    if (restarting) return;
    const running = app;
    if (!running) {
        startApp();
        return;
    }
    restarting = true;
    running.process.once('exit', () => {
        clearTimeout(force);
        restarting = false;
        startApp();
    });
    signalGroup(running, 'SIGTERM');
    // It should go at once; if it hangs, don't wait forever
    const force = setTimeout(() => signalGroup(running, 'SIGKILL'), 3000);
}

/**
 * Whether a change under app/ should restart the app. Build output is skipped (the restart's
 * own build writes there, which would loop), and so are dotfiles such as .DS_Store.
 *
 * @param file Path relative to app/.
 */
function isWatched(file: string): boolean {
    const parts = file.split(path.sep);
    return parts[0] !== 'build' && !parts.some((part) => part.startsWith('.'));
}

let debounce: NodeJS.Timeout | undefined;

// Recursive fs.watch is native on macOS. The debounce folds a burst (save-all, a git checkout)
// into one restart.
fs.watch('app', { recursive: true }, (_event, file) => {
    if (!file || !isWatched(file)) return;
    scheduleRestart('app/ changed');
});

/**
 * Restarts the app (and the server it owns) after a short debounce.
 *
 * @param reason
 */
function scheduleRestart(reason: string): void {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
        console.error(`\n${reason}; restarting the menu bar app.`);
        restartApp();
    }, 300);
}

// Before anything reads the saved apps: marketing.json goes at the top of the list.
try {
    const placed = placeMarketingFirst();
    if (placed) console.error(placed);
} catch (error) {
    console.error(`could not place marketing.json first: ${error instanceof Error ? error.message : error}`);
}

// A server already on the port would be attached to instead of started, and it would not be this
// checkout's code.
const taken = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ port: 7878, host: '127.0.0.1' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
});
if (taken) {
    console.error('port 7878 is already in use (an old dev loop or an installed dev.localhost?). Stop it first.');
    process.exit(1);
}

// The server is compiled here and run by the app, as in an installed one. tsc is the repo's own,
// not whichever is on PATH (a global one can be older than the pinned one).
const serverEntry = path.resolve('server/dist/server/index.js');
start('the server compiler', path.resolve('node_modules/.bin/tsc'), [
    '-w',
    '-p',
    'server/tsconfig.json',
    '--preserveWatchOutput',
    '--pretty',
]);

// The app's server writes here, not to this terminal; follow it so errors stay visible.
const serverLog = path.join(os.homedir(), '.dev.localhost/logs/server.log');
fs.mkdirSync(path.dirname(serverLog), { recursive: true });
fs.appendFileSync(serverLog, '');
start('the server log', 'tail', ['-n', '0', '-F', serverLog]);

// The first compile has to land before the app has a server to start.
while (!fs.existsSync(serverEntry)) await new Promise((resolve) => setTimeout(resolve, 200));

// tsc is incremental: a write here means server code changed and compiled.
fs.watch(path.dirname(serverEntry), { recursive: true }, (_event, file) => {
    if (file && !file.endsWith('.js')) return;
    scheduleRestart('the server was rebuilt');
});

// The app first: it starts the server, and rebuilds and restarts on its own changes.
startApp();

// Skrapa runs every command from the skrapa root. Its own tsc is found on PATH, so the repo's
// node_modules/.bin goes first (a global TypeScript can be older than the one pinned here).
process.env.PATH = `${path.resolve('node_modules/.bin')}${path.delimiter}${process.env.PATH ?? ''}`;
start('the website', path.resolve('node_modules/.bin/skrapa'), ['dev'], { cwd: 'web' });
