const { overrides } = require('@netlify/eslint-config-node')

module.exports = {
  extends: '@netlify/eslint-config-node',
  parserOptions: {
    sourceType: 'module',
  },
  rules: {
    'arrow-body-style': 'off',
    'no-param-reassign': ['error', { props: false }],
    'no-underscore-dangle': 'off',
    'no-magic-numbers': 'off',
    'n/prefer-global/process': 'off',
    'unicorn/numeric-separators-style': 'off',
    'unicorn/filename-case': ['error', { case: 'kebabCase' }],
    'import/no-namespace': 'off',
    'import/extensions': 'off',
    'max-depth': 'off',
  },
  overrides: [
    ...overrides,
    {
      files: ['src/run/handlers/**'],
      rules: {
        'max-statements': ['error', 30],
        'import/no-anonymous-default-export': 'off',
      },
    },
    {
      files: ['src/**/*.test.*'],
      rules: {
        'max-statements': off,
        'max-lines-per-function': off,
      },
    },
  ],
}