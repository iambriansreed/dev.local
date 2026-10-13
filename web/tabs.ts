/**
 * Tabs built from `role="tablist"` / `role="tab"` / `role="tabpanel"` markup, following the
 * WAI-ARIA tabs pattern: clicking a tab shows its panel, and Left/Right/Home/End move
 * between tabs with only the selected one in the Tab order. The markup already has the
 * first tab selected and the others' panels `hidden`, so the page reads right before
 * this runs.
 */
export function initTabs() {
    document.querySelectorAll<HTMLElement>('[role="tablist"]').forEach((list) => {
        const tabs = Array.from(list.querySelectorAll<HTMLButtonElement>('[role="tab"]'));

        const select = (chosen: HTMLButtonElement) => {
            for (const tab of tabs) {
                const selected = tab === chosen;
                tab.setAttribute('aria-selected', String(selected));
                tab.tabIndex = selected ? 0 : -1;
                const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
                if (panel) panel.hidden = !selected;
            }
        };

        tabs.forEach((tab, index) => {
            tab.addEventListener('click', () => select(tab));
            tab.addEventListener('keydown', (event) => {
                const next = {
                    ArrowRight: tabs[(index + 1) % tabs.length],
                    ArrowLeft: tabs[(index - 1 + tabs.length) % tabs.length],
                    Home: tabs[0],
                    End: tabs[tabs.length - 1],
                }[event.key];
                if (!next) return;
                event.preventDefault();
                select(next);
                next.focus();
            });
        });
    });
}
