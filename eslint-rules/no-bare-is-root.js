'use strict';

/**
 * Custom ESLint rule: oauth-scopes/no-bare-is-root
 *
 * `User.isRoot()` only looks at the user account, never at the credential. When a root user authenticates
 * with an OAuth or Personal Token that was not granted the `root` scope, `isRoot()` still returns true.
 *
 * This rule flags every `x.isRoot()` call that is not combined (`&&`) with `checkScope(req, 'root')`.
 * Use one of the helpers from server/graphql/common/scope-check.ts instead:
 *   - `isRemoteUserRoot(req)` for boolean checks (visibility filters, limits, ...)
 *   - `checkRemoteUserCanRoot(req)` to throw when the user is not root
 *
 * To opt out (e.g. a field that only reports whether the user is root and grants nothing),
 * add an eslint-disable comment with an explanation.
 */

const isRootScopeCheck = node =>
  node?.type === 'CallExpression' &&
  node.callee.type === 'Identifier' &&
  node.callee.name === 'checkScope' &&
  node.arguments[1]?.type === 'Literal' &&
  node.arguments[1].value === 'root';

/** Returns all the operands of the `a && b && c` chain that contains `node` */
const getAndChainOperands = node => {
  let top = node;
  while (top.parent?.type === 'ChainExpression' || top.parent?.type === 'LogicalExpression') {
    if (top.parent.type === 'LogicalExpression' && top.parent.operator !== '&&') {
      break;
    }
    top = top.parent;
  }

  const operands = [];
  const collect = current => {
    if (current.type === 'LogicalExpression' && current.operator === '&&') {
      collect(current.left);
      collect(current.right);
    } else {
      operands.push(current);
    }
  };
  collect(top);
  return operands;
};

// eslint-disable-next-line import/no-commonjs
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow `isRoot()` checks that ignore the OAuth/Personal Token `root` scope.',
      url: 'https://github.com/opencollective/opencollective-api/blob/main/server/graphql/common/scope-check.ts',
    },
    schema: [],
    messages: {
      bareIsRoot:
        '`isRoot()` ignores the `root` OAuth scope. Use `isRemoteUserRoot(req)` or `checkRemoteUserCanRoot(req)` ' +
        'from server/graphql/common/scope-check.ts. If root-ness grants nothing here, disable this rule with an ' +
        'explanatory comment.',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== 'MemberExpression' ||
          callee.computed ||
          callee.property.name !== 'isRoot' ||
          node.arguments.length !== 0
        ) {
          return;
        }

        if (getAndChainOperands(node).some(isRootScopeCheck)) {
          return;
        }

        context.report({ node, messageId: 'bareIsRoot' });
      },
    };
  },
};
