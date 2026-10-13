export function initCopyButtons() {
    document.querySelectorAll<HTMLButtonElement>('.copy-btn').forEach((btn) => {
        const target = btn.previousElementSibling;
        const text = target?.textContent ?? '';

        btn.addEventListener('click', async () => {
            await navigator.clipboard.writeText(text.trim());
            const original = btn.textContent;
            btn.textContent = 'Copied';
            setTimeout(() => {
                btn.textContent = original;
            }, 1500);
        });
    });
}
