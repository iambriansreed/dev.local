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
                Made with ❤️ by{' '}
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
