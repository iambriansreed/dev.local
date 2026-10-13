// dev.localhost — the dev servers we start, and what they print.
//
// Start used to write a `.command` file and hand it to Terminal, which left the
// process someone else's: we could see a port go busy and kill whatever held it,
// and that was the whole of our grip on it. Here the process is ours — spawned
// by this server, signalled by process group, and with its output kept in a ring
// buffer the console modal reads over the WebSocket.
//
// Zero dependencies; Node built-ins only. Nothing in here imports nginx.ts: this
// module is handed a name, a directory and a port, and knows nothing else about
// what a proxy is — which is what keeps the two files from importing each other.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LogFrame, ProcState, ProcSummary } from '../shared/types.ts';

/**
 * Where each dev server's output is also written, for Terminal to tail (Log in the menu
 * bar app). `<name>.log` is the output, `<name>.command` is the script Terminal runs.
 */
export const LOG_DIR = path.join(os.homedir(), '.dev.localhost', 'logs', 'apps');

/** Past this the log is moved to `<name>.1.log` and a new one is started. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;

export function logFile(name: string): string {
    return path.join(LOG_DIR, `${name}.log`);
}

export function commandFile(name: string): string {
    return path.join(LOG_DIR, `${name}.command`);
}

/**
 * The script Terminal runs to show a log: set the window title, then follow the file
 * from its last 500 lines onwards. `tail -F` follows by name, so it keeps going when the
 * log is rotated or the server restarts.
 */
export function commandScript(logPath: string, name: string): string {
    return [
        '#!/bin/sh',
        `printf '\\033]0;%s\\007' '${name}.log'`,
        `exec tail -n 500 -F '${logPath.replace(/'/g, `'\\''`)}'`,
        '',
    ].join('\n');
}

/** Whether a log that has grown to `bytes` is due to be rotated. */
export function shouldRotate(bytes: number): boolean {
    return bytes > LOG_MAX_BYTES;
}

/**
 * What Start runs when a proxy doesn't say otherwise: the script nearly every project has.
 * A proxy can carry its own (`command` in the store, the Dev command field in Settings) for
 * the ones that don't. Exported for the form's default and for `state()`.
 */
export const DEFAULT_COMMAND = 'npm run dev';

/**
 * The user's login shell, so `npm` resolves the way it does when they run it by
 * hand. `-l` is what makes that true: node, npm and everything else may live
 * behind nvm/asdf/Homebrew shims that only exist once a profile has been
 * sourced, and this server may itself have been launched from Finder with a PATH
 * that has none of it.
 */
const SHELL = process.env.SHELL || '/bin/zsh';

/**
 * The one line of shell between `script` and the login shell, and all it does is
 * take the command's stdin off the pty.
 *
 * `script` opens by reading the EOF off its own stdin — /dev/null, and it has to
 * be, see stdio below — and writing the terminal's EOF character into the pty,
 * where it waits in the input queue for someone to read it. Whoever reads first
 * gets end-of-input a millisecond into the run, and a dev server that watches
 * stdin takes that as its cue to leave: Vite listens for `end` on stdin and
 * exits the process on it, so `npm run dev` printed its banner, read the `^D`
 * that was already waiting and was gone — a start that looked like an instant
 * crash, with nothing in the log to say what had happened.
 *
 * /dev/null is end-of-input too, but nothing reads it: a dev server asks whether
 * stdin is a terminal before it listens to it, and this one isn't. What that
 * costs is the keyboard shortcuts, which a console with no way to type into it
 * could not have sent anyway. Color is untouched — stdout and stderr are still
 * the pty, and that is the fd everything checks before printing an escape.
 *
 * The shell and the command ride as `$0` and `$1` rather than spliced into the
 * string, so a command with a quote in it is still one word.
 */
const RUN = 'exec "$0" -lc "$1" </dev/null';

/**
 * How much output to keep per process. A dev server logging every request fills
 * this in an afternoon, and the oldest lines are the ones nobody scrolls back
 * to — the error that matters is almost always the newest thing on screen.
 */
const MAX_BYTES = 256 * 1024;

/** How long a stopped process gets to exit on its own before SIGKILL. */
const KILL_GRACE_MS = 3000;

/**
 * How long a dev server gets to bind its port before silence there starts to
 * mean something. A login shell sourcing a profile, then npm, then a first
 * build is comfortably ten seconds on a cold cache, so a start gets three times
 * that before a silent port counts against it.
 */
const REAP_GRACE_MS = 30_000;

/**
 * How long a port that *had* something on it may stay silent before the reaper
 * acts. A dev server rebinding after a full restart is quiet for a beat, and a
 * beat is a second or two; six is it not coming back.
 *
 * In milliseconds rather than a count of status ticks, because the ticks are
 * not a clock: liveStatus runs once per open live socket (see index.ts), so
 * counting them makes the reaper N times more trigger-happy with N clients
 * connected, and stop entirely with none.
 */
const REAP_QUIET_MS = 6000;

type Proc = {
    name: string;
    cmd: string;
    cwd: string;
    port: number;
    child: ChildProcess | null;
    /** Whether the pty's opening `^D` has been dealt with — see firstChunk. */
    started: boolean;
    /** The process group id — negated, this signals the whole tree. */
    pgid: number;
    startedAt: number;
    exitedAt?: number;
    exitCode?: number | null;
    signal?: string | null;
    /** Raw output, escape sequences and all. The console renders it. */
    buffer: string;
    /** The log file this run appends to. Gone once the run has ended. */
    file?: fs.WriteStream;
    /** Bytes in `file`, so rotation doesn't need a stat per chunk. */
    fileBytes: number;
    /** Set while a SIGKILL is pending, so stopping twice doesn't queue two. */
    killTimer?: NodeJS.Timeout;
    /** When `port` was first seen silent in the current run of silence, cleared
     *  every time something answers there again — see reap. */
    quietSince?: number;
    /** Whether anything ever answered on `port` during this run. Only the
     *  wording of the reaper's note turns on it, and that wording is the
     *  difference between "it died" and "it isn't where you said it would be". */
    bound?: boolean;
};

/**
 * By proxy name, and kept after the process exits — an exited entry is how you
 * read the crash that stopped it. Cleared when that proxy is started again.
 */
const procs = new Map<string, Proc>();

// --------------------------------------------------------------- subscribers
// One listener per open WebSocket (see server/index.ts). Output is pushed as it
// arrives rather than polled, and every listener decides for itself whether it
// cares — a socket whose console is shut asks for nothing.

type Listener = (frame: LogFrame) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}

function broadcast(name: string, text: string): void {
    for (const fn of listeners) {
        try {
            fn({ type: 'log', name, text });
        } catch {
            /* a socket that throws is one that is closing; cleanup is its own */
        }
    }
}

// ------------------------------------------------------------------ the buffer

/**
 * The pty's own opening line, which belongs to nobody.
 *
 * `script` reads the EOF off /dev/null and writes it into the pty, which echoes
 * it straight back as `^D` and a couple of backspaces before the command has
 * printed a thing. It is an artefact of how the terminal is allocated, not
 * output, so it never reaches the buffer — and it is only ever stripped from the
 * very first chunk, so a `^D` a program prints later is its own.
 */
function firstChunk(chunk: string): string {
    // The newline that ends it goes too — left in, it opens the console with a
    // blank line where the echo used to be.
    return chunk.replace(/^\^D[\b]*\r?\n?/, '');
}

/**
 * How a run opens: a rule, and then the command as you would have typed it.
 *
 * The prompt line is the point. It is the one line guaranteed to be there before
 * the process has printed anything of its own, and it answers the two questions
 * a log can't otherwise answer — what was run, and where — in the form everyone
 * already reads: a directory, a `$`, and a command.
 *
 * The rule above it is what keeps runs apart. The buffer carries over a restart,
 * so without it the second run's output would read as more of the first — the
 * same "ready in 412ms" twice, in one stream, with nothing to say which was
 * which. Skipped for the first run, where there is nothing to separate from.
 */
function sessionHeader(p: Proc): string {
    const when = new Date(p.startedAt).toLocaleTimeString();
    return (
        `${p.buffer ? '\n' : ''}\x1b[2m${'─'.repeat(24)} ${when} ${'─'.repeat(24)}\x1b[0m\n` +
        `\x1b[2m${shortPath(p.cwd)} $\x1b[0m \x1b[1m${p.cmd}\x1b[0m\n`
    );
}

/**
 * A line from us rather than from the process — same dim treatment and same
 * stamp as the session header, so the two read as one voice.
 *
 * Opens with a newline because of where it lands: the last thing a dev server
 * prints is very often a spinner frame, which by design leaves the cursor
 * mid-line so the next frame can overwrite it. Written straight on, the exit
 * note would finish that sentence for it — `- building 6[dev.localhost] …`.
 */
function note(text: string): string {
    return `\n\x1b[2m[dev.localhost] ${new Date().toLocaleTimeString()} · ${text}\x1b[0m\n`;
}

/** `~` for the home directory, as everything user-facing in this app shows it. */
function shortPath(dir: string): string {
    const home = os.homedir();
    return dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir;
}

function append(p: Proc, chunk: string): void {
    p.buffer += chunk;
    if (p.buffer.length > MAX_BYTES) {
        // Trim to a line boundary rather than mid-sequence: cutting an escape
        // in half would leave the console rendering `[32m` as text, and the
        // colour it opened never gets closed.
        const cut = p.buffer.indexOf('\n', p.buffer.length - MAX_BYTES);
        p.buffer = p.buffer.slice(cut === -1 ? p.buffer.length - MAX_BYTES : cut + 1);
    }
    writeLog(p, chunk);
    broadcast(p.name, chunk);
}

// --------------------------------------------------------------- the log file

/**
 * Open the file this run appends to, and write the `.command` script beside it. The
 * file is appended to rather than started over, so a restart keeps the output before
 * it, the same as the console buffer does.
 */
function openLog(p: Proc): void {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = logFile(p.name);
    p.fileBytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    p.file = fs.createWriteStream(file, { flags: 'a' });
    p.file.on('error', () => {
        /* a log that can't be written must not take the dev server down with it */
        p.file = undefined;
    });
    writeCommand(p.name);
}

/** The `.command` script for a name. Written rather than moved on rename, since it names its log. */
function writeCommand(name: string): void {
    const command = commandFile(name);
    fs.writeFileSync(command, commandScript(logFile(name), name), { mode: 0o755 });
    fs.chmodSync(command, 0o755);
}

function closeLog(p: Proc): void {
    p.file?.end();
    p.file = undefined;
}

function writeLog(p: Proc, chunk: string): void {
    if (!p.file) return;
    p.file.write(chunk);
    p.fileBytes += Buffer.byteLength(chunk);
    if (shouldRotate(p.fileBytes)) {
        closeLog(p);
        fs.renameSync(logFile(p.name), path.join(LOG_DIR, `${p.name}.1.log`));
        openLog(p);
    }
}

// ------------------------------------------------------------------- starting

export type StartResult = {
    ok: boolean;
    error?: string;
    /** Already up — Start on a running proxy is a no-op, not a failure. */
    already?: boolean;
    pid?: number;
    cmd?: string;
    path?: string;
};

/** What this module needs to know about a proxy to run it — and all it needs to
 *  know. `cmd` empty or absent means DEFAULT_COMMAND. */
export type Target = { name: string; cwd: string; port: number; cmd?: string };

/**
 * Spawn a proxy's dev server.
 *
 * Three wrappers sit between us and `npm run dev`, and each earns its place:
 *
 * `script -q /dev/null` (a macOS built-in) gives the command a real pty. Without
 * one, everything downstream sees a pipe, decides it isn't talking to a terminal
 * and turns colour off at the source — no renderer can put back what was never
 * printed. With it, Vite's colours and its spinner arrive exactly as they would
 * in a terminal.
 *
 * `/bin/sh -c` inside that is one line long and execs itself away: it is there
 * to point the command's stdin at /dev/null and nothing else (see RUN). POSIX
 * sh rather than the login shell because the redirect is written in its syntax,
 * and the login shell is whatever the user has set.
 *
 * The login shell it execs into is what makes `npm` resolve at all (see SHELL).
 *
 * `detached` is not about outliving us — the whole registry dies with the server
 * (see killAll). It gives the child a process group of its own, so stopping it
 * signals the dev server and everything it spawned rather than just the shell.
 */
export function start(p: Target): StartResult {
    const existing = procs.get(p.name);
    if (existing?.child && existing.exitedAt === undefined) {
        return { ok: true, already: true, pid: existing.pgid, cmd: existing.cmd, path: existing.cwd };
    }
    const command = p.cmd?.trim() || DEFAULT_COMMAND;

    const proc: Proc = {
        name: p.name,
        cmd: command,
        cwd: p.cwd,
        port: p.port,
        child: null,
        started: false,
        pgid: 0,
        startedAt: Date.now(),
        // Carried over from the run before it, rather than started empty. A
        // restart is nearly always a reaction to something the last run printed,
        // and wiping it at the moment you act on it is taking the evidence away
        // — the header below is what keeps the two apart. Clear is how you empty
        // it on purpose, and MAX_BYTES is what stops it growing forever.
        buffer: existing?.buffer ?? '',
        fileBytes: 0,
    };

    let child: ChildProcess;
    try {
        child = spawn('script', ['-q', '/dev/null', '/bin/sh', '-c', RUN, SHELL, command], {
            cwd: p.cwd,
            detached: true,
            // stdin is /dev/null and has to be. `script` copies the terminal
            // settings off its own stdin before it allocates the pty, and Node's
            // `'pipe'` is a socketpair rather than a pipe — tcgetattr on one
            // fails with ENOTSUP and script exits before running anything at
            // all. /dev/null answers that call, and script reads the EOF once
            // and carries on rather than spinning on it. (A named pipe is no
            // way round it either: macOS builds those on sockets too, so a fifo
            // fails in exactly the same breath.) What script does with that EOF
            // is the reason the command's own stdin is redirected — see RUN.
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // A pty with no TERM is a terminal that can't say what it is, and
                // a good deal of tooling reads that as "no colour".
                TERM: process.env.TERM || 'xterm-256color',
                // The pty already makes isatty true; these cover the tools that
                // ask their own way round.
                FORCE_COLOR: '3',
                CLICOLOR_FORCE: '1',
            },
        });
    } catch (err) {
        return { ok: false, error: `Could not start ${command}: ${(err as Error).message}` };
    }

    proc.child = child;
    proc.pgid = child.pid ?? 0;
    procs.set(p.name, proc);
    // Before the header, which is the first thing written to the file. A log that can't
    // be opened costs the file, not the run: the console still has the output.
    try {
        openLog(proc);
    } catch {
        proc.file = undefined;
    }

    // What is being run, before it has had a chance to say anything.
    //
    // Not decoration, and doing two jobs. A login shell that has to source a
    // profile, then npm, then the dev server itself, is several seconds of an
    // empty console — long enough to read as "nothing happened"; this says
    // otherwise, and names the command so the console never has to guess.
    //
    // And it is the line between one run and the next. The buffer carries over a
    // restart, so without a break in it the second run's output would read as
    // more of the first — the same "ready in 412ms" twice, in one stream, with
    // nothing to say which was which.
    //
    // Appended rather than written into the starting buffer, so it is broadcast
    // like any other output: a console already open on this proxy sees the new
    // run announce itself instead of output simply resuming.
    append(proc, sessionHeader(proc));

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
        const text = proc.started ? c : firstChunk(c);
        proc.started = true;
        if (text) append(proc, text);
    });
    // `script`'s own errors, not the app's — the app's stderr goes down the pty
    // with everything else, which is exactly why its colours survive.
    child.stderr?.on('data', (c: string) => append(proc, c));

    // Both endings are stamped the same way the header is, so a session in the
    // log has a time at each end and you can tell a crash on boot from one four
    // hours in without counting lines.
    child.on('error', (err: Error) => {
        append(proc, note(`could not run ${command}: ${err.message}`));
        finish(proc, null, null);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        append(proc, note(describeExit(code, signal)));
        finish(proc, code, signal);
    });

    return { ok: true, pid: proc.pgid, cmd: command, path: p.cwd };
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) return `stopped (${signal})`;
    return code ? `exited with code ${code}` : 'exited';
}

/** Record how a process ended, and stop treating it as live. */
function finish(p: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (p.exitedAt !== undefined) return; // 'error' then 'exit' — the first wins
    p.exitedAt = Date.now();
    p.exitCode = code;
    p.signal = signal;
    p.child = null;
    closeLog(p);
    if (p.killTimer) {
        clearTimeout(p.killTimer);
        p.killTimer = undefined;
    }
}

/**
 * End the runs that have already ended without telling us.
 *
 * `'exit'` fires when `script` exits, and `script` exits when the pty has nobody
 * left holding it open. A grandchild that inherited the pty and outlived the
 * shell holds it open indefinitely: the dev server is gone, its port is silent,
 * and we are still holding a child object for an exit that is never coming. That
 * entry is what the app reads as running, and it is running nothing.
 *
 * A liveness probe is no use against it — `process.kill(pgid, 0)` succeeds,
 * because the group leader really is alive. It is `script`. The port is the only
 * cheap thing that tells a wedged pty apart from a working one.
 *
 * Called from liveStatus, which is already asking the kernel for the listening
 * set every couple of seconds, so this rides along on a question we ask anyway.
 */
export function reap(ports: Set<number>): void {
    for (const p of procs.values()) {
        if (!p.child || p.exitedAt !== undefined) continue;
        // Answering right now. Whatever it was doing a tick ago, it isn't stuck.
        if (ports.has(p.port)) {
            p.quietSince = undefined;
            p.bound = true;
            continue;
        }
        // Still inside the wait every start gets — silence here is a build, not
        // a death, and there is no way to tell them apart this early anyway. It
        // covers a server that binds, then restarts itself on something it read
        // at startup, as much as one that has not bound yet.
        if (Date.now() - p.startedAt < REAP_GRACE_MS) continue;
        // Past that, it is how long *this* silence has lasted that decides, not
        // how long ago the process started: a dev server restarting an hour in
        // has no start grace left, and anchoring to startedAt would kill it for
        // taking a few seconds to come back.
        p.quietSince ??= Date.now();
        if (Date.now() - p.quietSince < REAP_QUIET_MS) continue;

        // Said in the console rather than nowhere: a process that disappears
        // without a word is the thing this whole function is fixing, and killing
        // it silently would only move the mystery. The two cases want different
        // sentences — one is a dev server that died, the other is very likely a
        // dev server that is alive and listening somewhere else.
        append(
            p,
            note(
                p.bound
                    ? `nothing is listening on ${p.port} any more — stopping it`
                    : `nothing ever listened on ${p.port} — stopping it. If it took another port, set that one on this proxy.`,
            ),
        );
        try {
            // The group rather than the leader: the leader is `script`, and
            // whatever is holding the pty open is somewhere underneath it.
            // SIGKILL rather than the usual grace — this one has had its thirty
            // seconds, and there are no sockets left to close politely.
            process.kill(-p.pgid, 'SIGKILL');
        } catch {
            /* already gone, which is the outcome we were after either way */
        }
        // Directly, rather than leaving it to the 'exit' handler. That handler
        // not firing is the reason this function exists: waiting on it here
        // would be waiting for the same event that already didn't come.
        finish(p, null, 'SIGKILL');
    }
}

// ------------------------------------------------------------------- stopping

export type StopResult = {
    ok: boolean;
    error?: string;
    /** Something was actually signalled. `false` means nothing was running. */
    stopped: boolean;
    /** It wasn't ours — killed by port, the way it was before any of this. */
    foreign?: boolean;
    pids?: string[];
};

/**
 * Stop a proxy's dev server, whoever started it.
 *
 * Ours gets a signal to the whole process group: `npm run dev` is a shell under
 * a pty under npm, and signalling the leader alone leaves the actual server
 * holding the port. SIGTERM first, since a dev server given the chance will
 * close its sockets and go; SIGKILL a few seconds later for one that won't.
 *
 * Anything else — a server the user started in their own terminal — is still
 * stopped by port, which is all we ever had before. The row can't tell the two
 * apart and shouldn't have to.
 */
export function stop(name: string, port: number): StopResult {
    const p = procs.get(name);
    if (p?.child && p.exitedAt === undefined) {
        try {
            process.kill(-p.pgid, 'SIGTERM');
        } catch {
            // Already gone between the check and the signal — the 'exit'
            // handler has it, or is about to.
            return { ok: true, stopped: false };
        }
        p.killTimer = setTimeout(() => {
            try {
                process.kill(-p.pgid, 'SIGKILL');
            } catch {
                /* it went on its own, which is the point of the grace */
            }
        }, KILL_GRACE_MS);
        // Timers don't hold the process open on our account.
        p.killTimer.unref?.();
        return { ok: true, stopped: true, pids: [String(p.pgid)] };
    }
    return killByPort(port);
}

/** The pre-spawn behaviour, kept for dev servers that aren't ours to signal. */
function killByPort(port: number): StopResult {
    const r = spawnSync('/bin/sh', ['-c', `lsof -nP -tiTCP:${port} -sTCP:LISTEN 2>/dev/null`], {
        encoding: 'utf8',
    });
    const pids = `${r.stdout || ''}`.split(/\s+/).filter(Boolean);
    if (!pids.length) return { ok: true, stopped: false };
    spawnSync('/bin/sh', ['-c', `kill ${pids.join(' ')}`]);
    return { ok: true, stopped: true, foreign: true, pids };
}

/**
 * Stop it, wait for it to actually be gone, start it again.
 *
 * The wait is the point: a dev server that hasn't released the port yet comes
 * straight back up with `EADDRINUSE`, which reads like a bug in the app rather
 * than in the restart. We watch for the exit we caused, and give up waiting a
 * little after SIGKILL would have landed.
 */
export function restart(p: Target): Promise<StartResult> {
    const existing = procs.get(p.name);
    const stopped = stop(p.name, p.port);
    if (!stopped.stopped || !existing?.child) return Promise.resolve(start(p));

    const child = existing.child;
    return new Promise<StartResult>((resolve) => {
        let done = false;
        const go = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(start(p));
        };
        const timer = setTimeout(go, KILL_GRACE_MS + 500);
        timer.unref?.();
        child.once('exit', go);
    });
}

/**
 * Take every dev server down with the server.
 *
 * Synchronous and signal-only, because the one caller is `process.on('exit')`,
 * where there is no event loop left to await anything on. A process group of
 * our own is what makes this possible at all — a plain kill would take the
 * shell and leave the server it started behind, holding its port with nothing
 * left to stop it from.
 */
export function killAll(): void {
    for (const p of procs.values()) {
        if (!p.child || p.exitedAt !== undefined) continue;
        try {
            process.kill(-p.pgid, 'SIGTERM');
        } catch {
            /* already gone */
        }
    }
}

// -------------------------------------------------------------------- reading

export function list(): ProcState[] {
    return [...procs.values()].map(toState);
}

function toState(p: Proc): ProcState {
    return {
        name: p.name,
        running: Boolean(p.child) && p.exitedAt === undefined,
        pid: p.pgid || undefined,
        cmd: p.cmd,
        cwd: p.cwd,
        startedAt: p.startedAt,
        exitedAt: p.exitedAt,
        exitCode: p.exitCode,
        signal: p.signal,
        bytes: p.buffer.length,
    };
}

/** The compact form the live push carries — see ProcSummary. */
export function summaries(): ProcSummary[] {
    return [...procs.values()].map((p) => ({
        name: p.name,
        running: Boolean(p.child) && p.exitedAt === undefined,
        exitCode: p.exitCode,
        signal: p.signal,
    }));
}

export function get(name: string): ProcState | null {
    const p = procs.get(name);
    return p ? toState(p) : null;
}

/** Everything buffered for one process. `null` when we never started it. */
export function log(name: string): string | null {
    return procs.get(name)?.buffer ?? null;
}

/**
 * Follow a proxy that has been renamed.
 *
 * The registry is keyed by proxy name, and a rename would otherwise strand a
 * running dev server under a key nothing looks up any more — its row would show
 * Start while the port stayed busy, and its output would sit in a console entry
 * named after a proxy that no longer exists.
 */
export function rename(from: string, to: string): void {
    const p = procs.get(from);
    if (!p || from === to) return;
    procs.delete(from);
    // The files follow the name, so Log keeps finding the output it always had. A run
    // still writing has its file closed first and reopened under the new name after.
    const running = p.file !== undefined;
    closeLog(p);
    moveIfPresent(logFile(from), logFile(to));
    moveIfPresent(path.join(LOG_DIR, `${from}.1.log`), path.join(LOG_DIR, `${to}.1.log`));
    fs.rmSync(commandFile(from), { force: true });
    writeCommand(to);
    p.name = to;
    procs.set(to, p);
    if (running) openLog(p);
}

function moveIfPresent(from: string, to: string): void {
    if (fs.existsSync(from)) fs.renameSync(from, to);
}

/** Stop a proxy's dev server and forget it — for a proxy being deleted, whose
 *  row is about to go and take every way of stopping it with it. */
export function remove(name: string, port: number): void {
    const p = procs.get(name);
    if (p) closeLog(p);
    stop(name, port);
    procs.delete(name);
    for (const file of [logFile(name), commandFile(name), path.join(LOG_DIR, `${name}.1.log`)]) {
        fs.rmSync(file, { force: true });
    }
}

/**
 * Empty a process's buffer without touching the process.
 *
 * "Start reading from here" — the next error isn't buried under an hour of
 * request logs. The entry itself stays either way, including for a process that
 * has exited: Clear is about the output, and a button that quietly removed the
 * thing you were looking at would be a different button.
 */
export function clear(name: string): boolean {
    const p = procs.get(name);
    if (!p) return false;
    p.buffer = '';
    return true;
}
