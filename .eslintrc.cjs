const { overrides } = require('@netlify/eslint-config-node')

/** @type {import('eslint').Linter.Config} */
module.exports = {
  extends: '@netlify/eslint-config-node',
  parserOptions: {
    sourceType: 'module',
  },
  rules: {
    'arrow-body-style': 'off',
    'class-methods-use-this': 'off',
    complexity: 'off',
    'func-style': 'off',
    'import/extensions': 'off',
    'line-comment-position': 'off',
    'max-depth': 'off',
    'max-lines': 'off',
    'max-lines-per-function': 'off',
    'max-nested-callbacks': 'off',
    'max-statements': 'off',
    'n/prefer-global/process': 'off',
    'no-inline-comments': 'off',
    'no-magic-numbers': 'off',
    'no-param-reassign': ['error', { props: false }],
    'no-underscore-dangle': 'off',
    'promise/always-return': 'off',
    'promise/catch-or-return': 'off',
    'promise/prefer-await-to-callbacks': 'off',
    'promise/prefer-await-to-then': 'off',
    'require-await': 'off',
    'sort-imports': [
      'error',
      {
        allowSeparatedGroups: true,
        ignoreCase: true,
        ignoreDeclarationSort: true,
      },
    ],
    'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    'unicorn/numeric-separators-style': 'off',
  },
  overrides: [
    ...overrides,
    {
      files: ['*.cts', '*mts', '*.ts', '*.tsx'],
      excludedFiles: ['*.test.ts'],
      parser: '@typescript-eslint/parser',
      parserOptions: {
        ecmaVersion: 'latest',
        project: true,
      },
      rules: {
        '@typescript-eslint/no-floating-promises': 'error',
      },
    },
    {
      files: ['src/run/handlers/**'],
      rules: {
        'import/no-anonymous-default-export': 'off',
      },
    },
    {
      files: ['src/run/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              {
                name: '@opentelemetry/api',
                importNames: ['trace'],
                message: 'Please use `getTracer()` from `./handlers/tracer.cjs` instead',
              },
            ],
            patterns: [
              {
                // only */storage/storage.cjs is allowed to be imported
                // rest are implementation details that should not be used directly
                group: ['*/storage/*', '!*/storage/storage.cjs'],
                message: 'Import public `[...]/storage/storage.cjs` module instead.',
              },
            ],
          },
        ],
      },
    },
    {
      files: ['src/build/templates/**/*'],
      rules: {
        'func-names': 'off',
        'import/no-anonymous-default-export': 'off',
        'import/no-unresolved': 'off',
        'n/no-missing-import': 'off',
      },
    },
  ],
}
