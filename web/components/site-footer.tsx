import { buildNumber } from '../build-number';
import { version } from '../version.json';

/**
 * Every page's footer: the app's version and build number (as its About panel shows
 * them), the credit, and what the site is built with.
 */
export function SiteFooter() {
    return (
        <footer class="site-footer">
            <p>
                v{version}
                {buildNumber ? ` (${buildNumber})` : ''}
            </p>
            <p>
                Made with{' '}
                <svg class="heart" viewBox="0 0 24 24" role="img" aria-label="love">
                    <path d="M12 21s-7.5-4.6-9.8-9.2C.6 8.6 2.4 4.5 6.3 4.5c2.3 0 3.9 1.3 5.7 3.4 1.8-2.1 3.4-3.4 5.7-3.4 3.9 0 5.7 4.1 4.1 7.3C19.5 16.4 12 21 12 21z" />
                </svg>{' '}
                by{' '}
                <a href="https://iambrian.com" target="_blank" rel="noopener">
                    Brian
                </a>
            </p>
            <p>
                Built with{' '}
                <a href="https://skrapa.iambrian.com" target="_blank" rel="noopener">
                    Skrapa
                </a>
            </p>
        </footer>
    );
}
