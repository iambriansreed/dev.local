// The shapes the server's API sends. The menu bar app decodes the same fields
// (app/Sources/DevLocalCore/Model.swift), so a change here is a change there.
//
// Everything here crosses the wire, which is the whole reason it lives in one
// file: a type declared twice is two types that only look the same, and the
// copy that drifts is found by a user rather than by tsc.
//
// Types only — nothing in here emits any JavaScript.

/** A proxy exactly as it is persisted in `proxies.json`. Nothing derived. */
export type Proxy = {
    name: string;
    port: number;
    path?: string;
    /**
     * What Start runs in `path`. Absent means the default (`npm run dev`) — the
     * usual case, and the reason it is optional rather than filled in on every
     * proxy: a stored copy of the default would go stale the day it changes.
     */
    command?: string;
    /**
     * `true` when `name` is a whole domain of the user's own (myapp.test) rather
     * than the label below `.localhost`. Absent means the original behaviour, so
     * a store written before custom domains existed still reads correctly.
     */
    custom?: boolean;
    /**
     * A display name for the app: the menu bar's label and the main line of its row
     * in Settings. Absent when empty, so a store written before titles existed reads as before.
     */
    title?: string;
};

/** Untrusted shape straight off a JSON request body. */
export type ProxyInput = {
    name?: unknown;
    port?: unknown;
    path?: unknown;
    command?: unknown;
    custom?: unknown;
    title?: unknown;
};

/**
 * A proxy as the API sends it: the stored fields, plus everything the
 * server works out at read time.
 *
 * Built from `Proxy` rather than restating it, so the persisted half can only
 * ever be described in one place. `state()` is what fills in the rest.
 */
export type ProxyState = Proxy & {
    /** The hostname it is served at — `.localhost` appended, or the custom domain whole. */
    host: string;
    provisioned: boolean;
    url: string;
    devRunning?: boolean;
    /** Something in /etc/hosts points this host at loopback. */
    hostsEntry?: boolean;
    /** That entry is inside our fenced block, so a fix removes it once no proxy uses it. */
    hostsManaged?: boolean;
    /** Not a `.localhost` name, and nothing resolves it — the domain is dead. */
    needsHosts?: boolean;
};

/** How the certificate was issued. mkcert when it's available, openssl otherwise. */
export type CertMethod = 'mkcert' | 'openssl';

/**
 * A dev server the management server started, running or finished.
 *
 * "Ours" is the whole distinction this type draws. A port can be busy because
 * something we spawned is listening on it or because the user started a dev
 * server in their own terminal — the row looks the same either way, but only the
 * first has output to show and a process group to signal. A proxy with no entry
 * here is the second kind.
 */
export type ProcState = {
    /** The proxy this belongs to. */
    name: string;
    running: boolean;
    /** Of the process group leader — `script`, with the dev server under it. */
    pid?: number;
    /** What was actually run, for the console to state rather than imply. */
    cmd: string;
    cwd: string;
    startedAt: number;
    exitedAt?: number;
    /** Both null while it runs; on exit exactly one of them is set. */
    exitCode?: number | null;
    signal?: string | null;
    /** How much output is buffered — the console's "is there anything to show". */
    bytes: number;
};

/**
 * The half of `ProcState` that is worth pushing every couple of seconds.
 *
 * `bytes` deliberately isn't in here: it changes with every line a dev server
 * prints, and the live push is compared against the last one to decide whether
 * the page needs re-rendering at all.
 */
export type ProcSummary = Pick<ProcState, 'name' | 'running' | 'exitCode' | 'signal'>;

/**
 * A process's output, pushed over the same socket as the status.
 *
 * `reset` marks the frame that carries the whole buffer — sent when the console
 * subscribes to a process — as against the chunks that follow it. The console
 * replaces its contents on one and appends on the other.
 */
export type LogFrame = {
    type: 'log';
    name: string;
    /** Raw output, escape sequences and all; the console renders them. */
    text: string;
    reset?: boolean;
};

/** Everything the menu and Settings show, as `GET /api/state` returns it. */
export type State = {
    proxies: ProxyState[];
    nginx: {
        installed: boolean;
        bin: string | null;
        version: string | null;
        running: boolean;
        installCmd: string;
    };
    cert: {
        exists: boolean;
        method: CertMethod | null;
        version: string | null;
        mkcertAvailable: boolean;
        hosts: string[];
        /** Only self-signed openssl certs need trusting by hand. */
        trustCmd: string | null;
    };
    // certInfo() also reports the cert and key paths. They are left out on
    // purpose: nothing reads them, and a field in here is one every test fixture
    // has to make up. This is what the app consumes, not a transcript of the
    // response — the server is free to send more.
    baseDir: string;
};

/**
 * The push sent over `/ws` every couple of seconds — just the things that change
 * on their own, so a status tick costs far less than a whole `State`.
 */
export type Live = {
    type: string;
    /**
     * Bumped on every write to `proxies.json`. A client that sees it change refetches
     * `/api/state`, which is how a change made in another window reaches this one.
     */
    rev: number;
    nginxRunning: boolean;
    /** Proxy name → is its dev server listening. */
    dev: Record<string, boolean>;
    /** Every process we started, running or finished — the console's list. */
    procs: ProcSummary[];
};
