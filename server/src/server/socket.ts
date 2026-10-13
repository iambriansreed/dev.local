// The API's Unix socket: a file in ~/.dev.localhost rather than a port on 127.0.0.1.
//
// A loopback port answers anything on the Mac, web pages included: a page can POST to
// 127.0.0.1 without a CORS preflight, and this API adds an app with any command and then
// starts it. A socket file is reachable only through the filesystem, and with its mode at
// 0600 only by its owner, so no browser can reach it however a request is dressed up.
import fs from 'node:fs';
import net from 'node:net';

/**
 * Whether the socket at `file` can be listened on. `taken` when a server answers there (the
 * menu bar app then attaches to it, as to one a terminal started); `free` when there is
 * nothing, or only the file a crashed server left behind, which is removed so listen() can
 * create it again.
 */
export function claimSocket(file: string): Promise<'free' | 'taken'> {
    if (!fs.existsSync(file)) return Promise.resolve('free');
    return new Promise((resolve) => {
        const probe = net.connect(file);
        probe.once('connect', () => {
            probe.destroy();
            resolve('taken');
        });
        probe.once('error', () => {
            fs.rmSync(file, { force: true });
            resolve('free');
        });
    });
}

/**
 * Listen on `file`, made 0600 before the first connection can arrive. The umask covers the
 * moment between bind() and the chmod, so the file is never open to anyone else.
 */
export function listenOnSocket(server: net.Server, file: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const umask = process.umask(0o177);
        server.once('error', reject);
        server.listen(file, () => {
            process.umask(umask);
            fs.chmodSync(file, 0o600);
            server.off('error', reject);
            resolve();
        });
    });
}
