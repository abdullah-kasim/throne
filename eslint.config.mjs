import tseslint from 'typescript-eslint';
import promise from 'eslint-plugin-promise';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'dist.build.*/**', '.dist-scratch.*/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      promise,
    },
    rules: {
      'promise/prefer-await-to-callbacks': 'warn',
      'promise/prefer-await-to-then': 'warn',
      'no-restricted-syntax': [
        'warn',
        {
          selector: "CallExpression[callee.property.name=/Sync$/]",
          message: 'Synchronous APIs are discouraged; prefer the async/promise-based equivalent.',
        },
        {
          selector: "CallExpression[callee.name=/Sync$/]",
          message: 'Synchronous APIs are discouraged; prefer the async/promise-based equivalent.',
        },
      ],
      'no-restricted-imports': [
        'warn',
        {
          paths: [
            {
              name: 'fs',
              message: "Import from 'node:fs/promises' instead of 'fs'.",
            },
            {
              name: 'node:fs',
              message: "Import from 'node:fs/promises' instead of 'node:fs'.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
