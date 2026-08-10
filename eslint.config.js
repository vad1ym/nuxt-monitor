import antfu from '@antfu/eslint-config'

/**
 * Lint rules.
 *
 * `@antfu/eslint-config` was already a dependency and `pnpm lint` already
 * referenced it; the config file it needs was simply never written, so the
 * script — and with it `pnpm verify` — failed on every run.
 */
export default antfu({
  type: 'lib',
  vue: true,
  typescript: true,
  // The repo is formatted by hand and reads deliberately; stylistic rules are
  // welcome, but they may not rewrite what they do not understand.
  stylistic: {
    indent: 2,
    quotes: 'single',
    semi: false,
  },
  ignores: [
    '**/dist/**',
    '**/.output/**',
    '**/.nuxt/**',
    '**/.monitor/**',
    '**/node_modules/**',
    'client/auto-imports.d.ts',
    'client/components.d.ts',
    'docs/.vitepress/cache/**',
    'docs/.vitepress/dist/**',
    // Prose with fenced code samples, parsed as source and failing on them.
    '**/*.md',
  ],
}, {
  rules: {
    // Reporting a failure is the job; the log is where it goes.
    'no-console': 'off',

    /**
     * Ordering rules are off.
     *
     * Imports here are grouped by origin and declarations are ordered so a
     * file reads top to bottom; a linter that alphabetises both would destroy
     * that to enforce a property nobody reads for. The rules below stay on
     * because each describes a defect rather than a preference — the regexp
     * ones caught a real one: two lazy groups in the stack parser could trade
     * characters, and a 64 KB line cost 1.2 seconds of CPU on an endpoint that
     * takes unauthenticated input.
     */
    'perfectionist/sort-imports': 'off',
    'perfectionist/sort-named-imports': 'off',
    'jsonc/sort-keys': 'off',
    'test/prefer-lowercase-title': 'off',

    // `process` and `Buffer` are globals in every runtime this targets, and
    // the module is ESM — `require` is not available to follow this advice.
    'node/prefer-global/process': 'off',
    'node/prefer-global/buffer': 'off',

    /**
     * Formatting rules that rewrite prose or reflow code that was laid out to
     * be read. Left off rather than fixed: the autofixer's first pass mangled
     * a comment explaining a 0-based/1-based conversion, which is the kind of
     * text that exists precisely because it is easy to get wrong.
     */
    'style/quote-props': 'off',
    'style/operator-linebreak': 'off',
    'style/indent-binary-ops': 'off',
    'style/max-statements-per-line': 'off',
    'antfu/consistent-chaining': 'off',
    'jsdoc/multiline-blocks': 'off',
    'vue/singleline-html-element-content-newline': 'off',
    'vue/first-attribute-linebreak': 'off',
    'vue/html-closing-bracket-newline': 'off',
    'vue/block-tag-newline': 'off',

    // A CLI entry point is exactly where top-level await belongs.
    'antfu/no-top-level-await': 'off',

    // The workspace file is deliberate; these are opinions about pnpm setup.
    'pnpm/yaml-enforce-settings': 'off',
  },
})
