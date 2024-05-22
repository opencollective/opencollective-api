const baseConfig = {
  extends: ['opencollective'],
  processor: '@graphql-eslint/graphql',
  env: { mocha: true },
  plugins: ['mocha'],
  rules: {
    // console logs are OK in Node
    'no-console': 'off',
    'mocha/no-exclusive-tests': 'error',
    // use es6 module imports and exports
    'import/no-commonjs': 'error',
    // not useful or desired
    'import/no-named-as-default-member': 'off',
    // common warnings in the codebase
    'n/no-process-exit': 'off',
    'node/shebang': 'off',
    'no-useless-escape': 'off',
    'prefer-rest-params': 'off',
    // relaxing because we have many errors
    'require-atomic-updates': 'off',
    // enforce strictly camelcase
    camelcase: 'error',
    // disallow unsupported Node.js built-in APIs on the specified version
    // https://github.com/eslint-community/eslint-plugin-n/blob/master/docs/rules/no-unsupported-features/node-builtins.md
    'n/no-unsupported-features/node-builtins': 'off',
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
