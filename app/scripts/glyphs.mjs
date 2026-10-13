#!/usr/bin/env node
// Writes one SVG per menu glyph into the directory given, black on transparent at 64 px,
// for make-icons.sh to turn into template PNGs. The paths are the ones the mocks draw
// (.plans/mocks/generate.mjs), on a 24-unit grid.
import fs from 'node:fs';
import path from 'node:path';

const GLYPHS = {
    edit: { s: ['M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4z', 'M13.5 6.5l4 4'] },
    clone: { s: ['M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1'], r: [9, 9, 12, 12, 2] },
    code: {
        f: 'M23.15 2.587L18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z',
    },
    terminal: { s: ['M4 7l5 5-5 5', 'M12.5 17h7.5'] },
    play: { f: 'M8 5.4v13.2L18.5 12z' },
    stop: { fr: [6.5, 6.5, 11, 11, 2] },
    plus: { s: ['M12 5v14M5 12h14'] },
    gear: {
        s: [
            'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
            'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
        ],
    },
    power: { s: ['M12 3v8', 'M6.3 6.8a8 8 0 1 0 11.4 0'] },
    warning: {
        s: ['M10.3 4.9 2.6 18.2a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.9a2 2 0 0 0-3.4 0z', 'M12 10v4', 'M12 17.2h.01'],
    },
};

const out = process.argv[2];
fs.mkdirSync(out, { recursive: true });
for (const [name, g] of Object.entries(GLYPHS)) {
    let body = '';
    for (const d of g.s ?? [])
        body += `<path d="${d}" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (g.r)
        body += `<rect x="${g.r[0]}" y="${g.r[1]}" width="${g.r[2]}" height="${g.r[3]}" rx="${g.r[4]}" fill="none" stroke="#000" stroke-width="2"/>`;
    if (g.f) body += `<path d="${g.f}" fill="#000"/>`;
    if (g.fr) body += `<rect x="${g.fr[0]}" y="${g.fr[1]}" width="${g.fr[2]}" height="${g.fr[3]}" rx="${g.fr[4]}" fill="#000"/>`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24"><rect width="24" height="24" fill="#fff"/>${body}</svg>`;
    fs.writeFileSync(path.join(out, `${name}.svg`), svg);
}
console.log(Object.keys(GLYPHS).join(' '));
