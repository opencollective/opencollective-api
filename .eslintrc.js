const baseConfig = {
  extends: ['opencollective', 'plugin:@typescript-eslint/recommended', 'plugin:import/typescript'],
  parser: '@typescript-eslint/parser',
  processor: '@graphql-eslint/graphql',
  env: { mocha: true },
  plugins: ['@typescript-eslint', 'mocha', 'simple-import-sort'],
  rules: {
    // console logs are OK in Node
    'no-console': 'off',
    'mocha/no-exclusive-tests': 'error',
    // use es6 module imports and exports
    'import/no-commonjs': 'error',
    // not useful or desired
    'import/no-named-as-default-member': 'off',
    // common warnings in the codebase
    'no-process-exit': 'off',
    'node/shebang': 'off',
    'no-useless-escape': 'off',
    'prefer-rest-params': 'off',
    // "@typescript-eslint/no-explicit-any": "off",
    // relaxing because we have many errors
    'require-atomic-updates': 'off',
    // typescript
    'node/no-missing-import': ['error', { tryExtensions: ['.js', '.ts'] }],
    // enforce strictly camelcase
    camelcase: 'error',
    // simple-import-sort
    'simple-import-sort/imports': [
      'error',
      {
        groups: [
          // Side effect imports.
          ['^\\u0000'],
          // Node.js builtins. You could also generate this regex if you use a `.js` config.
          // For example: `^(${require("module").builtinModules.join("|")})(/|$)`
          // eslint-disable-next-line
          [`^(${require('module').builtinModules.join('|')})(/|$)`],
          // Packages.
          // Things that start with a letter (or digit or underscore), or `@` followed by a letter.
          ['^@?\\w'],
          // Absolute imports and other imports such as Vue-style `@/foo`.
          // Anything that does not start with a dot.
          ['^[^.]'],
          // Parent imports. Put `..` last.
          ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
          // Other relative imports. Put same-folder imports and `.` last.
          ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$'],
        ],
      },
    ],
    // tweak typescript defaults
    '@typescript-eslint/ban-types': 'warn',
    '@typescript-eslint/no-explicit-any': 'warn',
    // Already being validated by @typescript-eslint/no-unused-vars
    'no-unused-vars': 'off',
    '@typescript-eslint/no-unused-vars': ['error'],
  },
};

const graphqlConfig = {
  parser: '@graphql-eslint/eslint-plugin',
  plugins: ['@graphql-eslint'],
  settings: {
    // Ignore .d.ts files for import (they just define the types)
    'import/ignore': ['.d.ts$'],
  },
  rules: {
    '@graphql-eslint/no-deprecated': 'warn',
    '@graphql-eslint/fields-on-correct-type': 'error',
    '@graphql-eslint/no-duplicate-fields': 'error',
    '@graphql-eslint/naming-convention': [
      'error',
      {
        VariableDefinition: 'camelCase',
        OperationDefinition: {
          style: 'PascalCase',
          forbiddenPrefixes: ['get', 'fetch'],
          forbiddenSuffixes: ['Query', 'Mutation', 'Fragment'],
        },
      },
    ],
  },
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  root: true,
  ignorePatterns: ['./server/graphql/*.graphql'],
  overrides: [
    {
      files: ['*.js', '*.ts'],
      ...baseConfig,
    },
    {
      files: ['*.graphql'],
      ...graphqlConfig,
    },
    {
      files: ['*.js'],
      rules: {
        '@typescript-eslint/no-use-before-define': 'off',
        '@typescript-eslint/indent': 'off',
        '@typescript-eslint/explicit-function-return-type': 'off',
        '@typescript-eslint/explicit-module-boundary-types': 'off',
      },
    },
    {
      files: ['server/graphql/v2/**/*.+(js|ts)'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['**/v1/types'],
                message: 'GraphQL V1 types should not be used with V2.',
              },
            ],
          },
        ],
      },
    },
  ],
};
