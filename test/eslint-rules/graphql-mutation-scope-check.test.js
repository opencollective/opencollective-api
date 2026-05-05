/**
 * Tests for the graphql-mutations/require-scope-check ESLint rule.
 *
 * Uses ESLint's RuleTester which integrates with Mocha's describe/it globals.
 */

import { RuleTester } from 'eslint';

import rule from '../../eslint-rules/graphql-mutation-scope-check.js';

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

ruleTester.run('graphql-mutations/require-scope-check', rule, {
  valid: [
    // -----------------------------------------------------------------------
    // Direct call to enforceScope in arrow function body
    // -----------------------------------------------------------------------
    {
      name: 'enforceScope call in arrow function resolver',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              enforceScope(req, 'host');
              return doSomething();
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Named scope-check helpers
    // -----------------------------------------------------------------------
    {
      name: 'checkRemoteUserCanUseAccount call',
      code: `
        export default {
          updateAccount: {
            type: GraphQLAccount,
            resolve: async (_, args, req) => {
              checkRemoteUserCanUseAccount(req);
              return updateAccount(args, req);
            },
          },
        };
      `,
    },
    {
      name: 'checkRemoteUserCanRoot call',
      code: `
        export default {
          editFlags: {
            type: GraphQLAccount,
            resolve: async (_, args, req) => {
              checkRemoteUserCanRoot(req);
              return editFlags(args, req);
            },
          },
        };
      `,
    },
    {
      name: 'checkRemoteUserCanUseExpenses call',
      code: `
        export default {
          createExpense: {
            type: GraphQLExpense,
            resolve: async (_, args, req) => {
              checkRemoteUserCanUseExpenses(req);
              return createExpense(args, req);
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Scope check inside a conditional branch
    // -----------------------------------------------------------------------
    {
      name: 'enforceScope inside an if block',
      code: `
        export default {
          updateFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              if (req.userToken) {
                enforceScope(req, 'host');
              }
              return updateFoo(args);
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Shorthand method syntax
    // -----------------------------------------------------------------------
    {
      name: 'shorthand async resolve method',
      code: `
        export default {
          deleteFoo: {
            type: GraphQLFoo,
            async resolve(_, args, req) {
              checkRemoteUserCanUseHost(req);
              return deleteFoo(args);
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Named export (not default)
    // -----------------------------------------------------------------------
    {
      name: 'named export with scope check',
      code: `
        export const myMutations = {
          createBar: {
            type: GraphQLBar,
            resolve: async (_, args, req) => {
              enforceScope(req, 'orders');
              return createBar(args);
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Single mutation export (not wrapped in an outer object)
    // -----------------------------------------------------------------------
    {
      name: 'single exported mutation with scope check',
      code: `
        export const sendSurvey = {
          type: GraphQLBoolean,
          resolve: async (_, args, req) => {
            enforceScope(req, 'account');
            return sendSurvey(args);
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Scope check in a try block
    // -----------------------------------------------------------------------
    {
      name: 'scope check inside try block',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              try {
                enforceScope(req, 'host');
                return doSomething();
              } catch (e) {
                throw e;
              }
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // checkScope (boolean check) is also accepted
    // -----------------------------------------------------------------------
    {
      name: 'checkScope call counts as a scope check',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              if (!checkScope(req, 'orders')) {
                throw new Forbidden();
              }
              return doSomething();
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Non-resolve properties with functions are not checked
    // -----------------------------------------------------------------------
    {
      name: 'non-resolve property is ignored',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            deprecationReason: 'Use createBar instead',
            beforeResolve: async (_, args, req) => {
              // no scope check needed here
              return preprocess(args);
            },
            resolve: async (_, args, req) => {
              checkRemoteUserCanUseHost(req);
              return doSomething();
            },
          },
        };
      `,
    },

    // -----------------------------------------------------------------------
    // Scope check in nested block (switch statement)
    // -----------------------------------------------------------------------
    {
      name: 'scope check inside switch statement',
      code: `
        export default {
          processFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              switch (args.action) {
                case 'create':
                  enforceScope(req, 'host');
                  break;
                default:
                  break;
              }
              return process(args);
            },
          },
        };
      `,
    },
  ],

  invalid: [
    // -----------------------------------------------------------------------
    // Missing scope check entirely
    // -----------------------------------------------------------------------
    {
      name: 'no scope check in resolver',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              if (!req.remoteUser) {
                throw new Unauthorized();
              }
              return doSomething();
            },
          },
        };
      `,
      errors: [{ messageId: 'missingScopeCheck' }],
    },

    // -----------------------------------------------------------------------
    // Scope check only in a nested callback – does NOT count
    // -----------------------------------------------------------------------
    {
      name: 'scope check inside a nested arrow function is not counted',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              const results = await Promise.all(
                ids.map(async id => {
                  enforceScope(req, 'host'); // inside a nested function – not counted
                  return processId(id);
                }),
              );
              return results;
            },
          },
        };
      `,
      errors: [{ messageId: 'missingScopeCheck' }],
    },

    // -----------------------------------------------------------------------
    // Scope check only in a called helper – does NOT count
    // -----------------------------------------------------------------------
    {
      name: 'scope check only in a called helper function is not counted',
      code: `
        async function helperWithScopeCheck(req) {
          enforceScope(req, 'host');
          return doWork();
        }

        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              return helperWithScopeCheck(req);
            },
          },
        };
      `,
      errors: [{ messageId: 'missingScopeCheck' }],
    },

    // -----------------------------------------------------------------------
    // Multiple mutations – only the one missing the check is reported
    // -----------------------------------------------------------------------
    {
      name: 'one of two mutations is missing a scope check',
      code: `
        export default {
          createFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              enforceScope(req, 'host');
              return createFoo(args);
            },
          },
          deleteFoo: {
            type: GraphQLFoo,
            resolve: async (_, args, req) => {
              // forgot the scope check
              return deleteFoo(args.id);
            },
          },
        };
      `,
      errors: [{ messageId: 'missingScopeCheck' }],
    },

    // -----------------------------------------------------------------------
    // Named export without scope check
    // -----------------------------------------------------------------------
    {
      name: 'named export mutation missing scope check',
      code: `
        export const myMutation = {
          type: GraphQLBoolean,
          resolve: async (_, args, req) => {
            if (!req.remoteUser) {
              throw new Unauthorized();
            }
            return sendData(args);
          },
        };
      `,
      errors: [{ messageId: 'missingScopeCheck' }],
    },

    // -----------------------------------------------------------------------
    // Empty resolver body
    // -----------------------------------------------------------------------
    {
      name: 'completely empty resolver',
      code: `
        export default {
          noop: {
            type: GraphQLBoolean,
            resolve: async () => {
              return true;
            },
          },
        };
      `,
      errors: [{ messageId: 'missingScopeCheck' }],
    },
  ],
});
