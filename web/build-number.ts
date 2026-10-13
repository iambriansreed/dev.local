import { execFileSync } from 'child_process';
import { version } from './version.json';

/**
 * The released app's build number, as its About panel shows it: app/scripts/bundle.sh
 * stamps the git commit count into the bundle, and a release is built at its
 * v<version> tag, so the count up to that tag is the same number.
 *
 * Pages render in Node at build time, so this runs git then. Undefined when the tag
 * doesn't exist yet (a version set by hand, not yet released) or there is no git
 * history, rather than a count that matches no build anyone has. CI needs a full
 * clone with tags for it (fetch-depth: 0 in deploy-web.yml).
 */
export const buildNumber: string | undefined = (() => {
    try {
        return execFileSync('git', ['rev-list', '--count', `v${version}`], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return undefined;
    }
})();
