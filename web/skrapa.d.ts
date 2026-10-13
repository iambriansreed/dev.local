/**
 * SKRAPA Types - managed by skrapa.
 *
 * Every skrapa command checks this file and rewrites it only when it differs
 * from the version bundled with your installed skrapa, so edits here are
 * overwritten on the next run. Do NOT add your own global types here; put
 * project globals in a separate `.d.ts` file instead.
 *
 * Types live under the `Skrapa` namespace so nothing shipped here can collide
 * with a type of your own. The four names outside it are the ones the compiler
 * and the runtime must find globally, by exactly these names: `jsx` and
 * `Fragment` are the JSX factory pair named in tsconfig.json and are called by
 * the emitted code, `JSX` is where TypeScript looks up intrinsic elements, and
 * `VERSION` is injected as a global at build time. Moving any of them into the
 * namespace makes every `<div>` fail to compile.
 */
declare global {
    namespace Skrapa {
        type CSSProps = Partial<CSSStyleDeclaration> & {
            [key: `--${string}`]: string | number; // Support for CSS variables (custom properties)
        };

        /**
         * One thing that may appear in a child position.
         *
         * `null`, `undefined` and booleans render as nothing, which is what
         * makes `{flag && <p>hi</p>}` work. A `string` or `number` renders as
         * escaped text, never as markup: to emit markup held in a string, wrap
         * it in {@link raw}.
         */
        type Child = JSX.Element | string | number | boolean | null | undefined;

        /**
         * What a child position accepts: one {@link Child}, or any nesting of
         * arrays of them. The recursion is deliberate, since a nested map
         * (`rows.map((r) => r.cells.map(...))`) produces arrays of arrays, and
         * every level is flattened when rendered.
         */
        type Children = Child | readonly Children[];

        type Props = {
            children?: never;
            style?: CSSProps;
        };

        type PropsWithChildren = {
            children?: Children;
            style?: CSSProps;
        };

        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        type Tag = string | Function;

        type Page =
            | JSX.Element
            | {
                  /**
                   * Replaces the text of the shell's <title> element. The shell
                   * must already contain a <title> tag; if it does not, this is
                   * ignored.
                   */
                  title?: string;
                  /** Appended to the shell's <body>, just before </body> */
                  body?: JSX.Element;
                  /** Appended to the shell's <head>, just before </head> */
                  head?: string;
                  /**
                   * Attributes to set on the shell's <html> and <body> elements. Anything the
                   * shell already set and you do not name here is left alone.
                   *
                   * A string overwrites: whatever the shell had for that attribute
                   * is gone. To build on the existing value instead, pass a
                   * function; it receives the shell's current value ('' if it set
                   * none) and returns the new one:
                   *
                   *     html: {
                   *         lang: 'fr',                            // overwrite
                   *         class: (prev) => `${prev} dark`,       // merge
                   *     }
                   */
                  shellAttrs?: {
                      /** Set on the shell's opening <html> tag. */
                      html?: Record<string, string | ((prev: string) => string)>;
                      /** Set on the shell's opening <body> tag. */
                      body?: Record<string, string | ((prev: string) => string)>;
                  };
              };

        /**
         * A base path, always leading-slash-prefixed: `"/"` for a site at the
         * domain root, `"/repo/"` for one served from a subpath.
         */
        type BasePath = `/${string}`;

        /**
         * A public origin including its scheme, e.g. `"https://dev.localhost"`.
         * `""` means nothing is proxying the dev server, so its URL is derived
         * from `host` and `port` instead.
         */
        type Origin = `${string}://${string}` | '';

        /**
         * The `skrapa` key of a tsconfig.json. Required: `true` for every
         * default, or an object of settings. Every path is relative to
         * wherever the tsconfig.json is; a CLI flag of the same name
         * overrides it.
         *
         *     { "skrapa": { "output": "../dist", "projectRoot": "../" } }
         *
         * skrapa always compiles to `.skrapa/` beside the tsconfig.json;
         * `compilerOptions.outDir`/`rootDir` are ignored.
         */
        type Config = {
            /**
             * Build output dir. Served and live-reloaded in dev mode.
             * @default "dist"
             */
            output?: string;
            /**
             * Static files copied to output as-is; copied live in dev mode.
             * @default "assets"
             */
            assets?: string;
            /**
             * Dev server port. Errors rather than picking another if it's taken.
             * @default 8080
             */
            port?: number;
            /**
             * Dev server bind address. See {@link Config.origin} for the reachable URL.
             * @default "localhost"
             */
            host?: string;
            /**
             * Public origin behind a proxy/tunnel, e.g. `"https://dev.localhost"`.
             * Cosmetic: only changes the logged URL.
             * @default ""
             */
            origin?: Origin;
            /**
             * Base path the site is served from, injected as `<base href>`.
             * Set for a subpath deploy, e.g. GitHub Pages: `"/my-site/"`.
             * https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/base
             * @default "/"
             */
            base?: BasePath;
            /**
             * URL paths the link check skips (a proxied API, hand-uploaded
             * files, a generated sitemap). `*` matches one path segment, `**`
             * any number, a trailing `/**` also covers the path itself.
             *
             *     ["/api/**", "/uploads/*.pdf"]
             * @default []
             */
            linkCheckIgnore?: readonly string[];
            /**
             * Where project files (`.github/`, `.gitignore`, `package.json`,
             * `skrapa.d.ts`) live, when tsconfig.json sits in the source dir
             * instead. Set at most one of `projectRoot`/`source`, never both.
             */
            projectRoot?: string;
            /**
             * Where the pages live, when tsconfig.json sits in the project
             * root instead. Set at most one of `projectRoot`/`source`, never
             * both.
             */
            source?: string;
        };
    }

    function jsx(
        tag: Skrapa.Tag,
        props: Skrapa.Props | undefined,
        ...children: Skrapa.Children[]
    ): JSX.Element;

    /**
     * Mark HTML you built yourself as a {@link JSX.Element}, so it renders as
     * markup instead of being escaped.
     *
     * Every string reaching a child position is HTML-escaped, which is what
     * makes `{userName}` safe by default. `raw` is the deliberate way out, for
     * when you really do have markup sitting in a string:
     *
     *     export function Page(): Skrapa.Page {
     *         return raw(rows.map((r) => `<li>${r}</li>`).join(''));
     *     }
     *
     * Nothing here is escaped or checked. Whatever you pass is emitted verbatim,
     * so never build one out of untrusted input.
     */
    function raw(html: string): JSX.Element;

    // `var`, not `let`: only a var declaration becomes a property of
    // `typeof globalThis`, and index.ts assigns both through globalThis.

    /**
     * The `<>...</>` factory, named by tsconfig's `jsxFragmentFactory`. Renders
     * its children with no wrapping element.
     *
     * It has to be callable: TypeScript rejects `<>` outright ("does not have
     * any construct or call signatures") if this is anything else.
     */
    var Fragment: (props: Skrapa.PropsWithChildren) => JSX.Element;

    var VERSION: string;

    namespace JSX {
        interface IntrinsicElements {
            [elemName: string]: unknown;
        }
        /**
         * Names the prop that receives JSX children. TypeScript reads only the
         * key* here and ignores the value type, so the shape a child position
         * actually accepts lives on `jsx`'s rest parameter and on
         * {@link Skrapa.PropsWithChildren}, both {@link Skrapa.Children}.
         */
        interface ElementChildrenAttribute {
            children: Skrapa.Children;
        }
        /**
         * Rendered JSX.
         *
         * Deliberately *not* a string. Skrapa escapes every string that lands in
         * a child position, so an element has to be distinguishable from text at
         * runtime, not merely in the type system. That is what lets
         * `{<b>hi</b>}` render as markup while `{'<b>hi</b>'}` renders as
         * visible text.
         *
         * It stringifies to its HTML, so `String(el)` and `` `${el}` `` both
         * give the markup. To go the other way, from a string you built to an
         * element, use {@link raw}.
         */
        interface Element {
            /** Phantom brand. No such property exists on the value. */
            readonly __jsx: 'element';
            toString(): string;
        }
    }
}

export declare const Fragment = 'Fragment';
/** < SKRAPA Types */
