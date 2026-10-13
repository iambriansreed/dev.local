// socket.ts - claiming the Unix socket the API listens on.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { claimSocket, listenOnSocket } from './socket.ts';

describe('server/src/server/socket.ts - claimSocket, listenOnSocket', () => {
    let dir: string;

    before(() => {
        // Short on purpose: a socket path has to fit in sockaddr_un (104 bytes on macOS)
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dls-'));
    });

    after(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('a path with nothing there is free', async () => {
        assert.equal(await claimSocket(path.join(dir, 'none.sock')), 'free');
    });

    // A server that crashed leaves its socket file behind, and listen() fails on an existing path
    test('a socket file nothing listens on is stale: removed and free', async () => {
        const file = path.join(dir, 'stale.sock');
        // A listener killed outright (SIGKILL, as a crash) never unlinks its file
        const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(file)})`]);
        while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 20));
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
        assert.ok(fs.existsSync(file));
        assert.equal(await claimSocket(file), 'free');
        assert.equal(fs.existsSync(file), false);
    });

    // A second server must attach rather than steal the socket from the first
    test('a socket a server is listening on is taken, and left alone', async () => {
        const file = path.join(dir, 'live.sock');
        const server = net.createServer((c) => c.end());
        await new Promise<void>((resolve) => server.listen(file, resolve));
        try {
            assert.equal(await claimSocket(file), 'taken');
            assert.ok(fs.existsSync(file));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    // Only the user may connect: the socket is the whole API, start-a-command included
    test('listens with the socket readable and writable by its owner alone', async () => {
        const file = path.join(dir, 'owned.sock');
        const server = net.createServer((c) => c.end());
        await listenOnSocket(server, file);
        try {
            assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});
