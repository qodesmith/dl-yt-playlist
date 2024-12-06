import pluginJs from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import importPlugin from 'eslint-plugin-import'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/** @type {import('eslint').Linter.Config[]} */
export default [
  {files: ['**/*.{js,mjs,cjs,ts}']},
  {languageOptions: {globals: globals.browser}},
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  {
    /**
     * These settings are necessary to avoid errors reported about missing node
     * modules that are actually installed.
     */
    settings: {
      'import/extensions': ['.ts'],
      'import/resolver': {typescript: true, node: true},
    },

    rules: {
      'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import/order': [
        'error',
        {
          'newlines-between': 'always',
          groups: [
            'type',
            'builtin',
            'external',
            'internal',
            ['sibling', 'parent'],
            'index',
            'object',
          ],
          alphabetize: {order: 'asc', caseInsensitive: true},
        },
      ],
      'import/no-named-as-default-member': 'off',
      'import/default': 'off',
    },
  },
  eslintConfigPrettier,
]
