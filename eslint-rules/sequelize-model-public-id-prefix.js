'use strict';

/**
 * Custom ESLint rule: sequelize-model/require-public-id-prefix
 *
 * Ensures every Sequelize model class (extends ModelWithPublicId) has:
 *   public static readonly nanoIdPrefix = '<prefix>' as const;
 */

const NODE_TYPES = {
  Identifier: 'Identifier',
  MemberExpression: 'MemberExpression',
  Literal: 'Literal',
  PropertyDefinition: 'PropertyDefinition',
  ClassDeclaration: 'ClassDeclaration',
  TSAsExpression: 'TSAsExpression',
  TSTypeAssertion: 'TSTypeAssertion',
};

function isSequelizeModelClass(node) {
  if (node.type !== NODE_TYPES.ClassDeclaration || !node.superClass) {
    return false;
  }

  if (node.abstract) {
    return false;
  }

  const superClass = node.superClass;
  if (superClass.type === NODE_TYPES.Identifier) {
    return superClass.name === 'ModelWithPublicId';
  }
  return false;
}

function getPropertyKeyName(key) {
  if (!key) {
    return null;
  }
  if (key.type === NODE_TYPES.Identifier) {
    return key.name;
  }
  if (key.type === NODE_TYPES.Literal && typeof key.value === 'string') {
    return key.value;
  }
  return null;
}

function isStringLiteralWithAsConst(valueNode) {
  if (!valueNode) {
    return false;
  }
  let inner = valueNode;
  if (valueNode.type === NODE_TYPES.TSAsExpression || valueNode.type === NODE_TYPES.TSTypeAssertion) {
    inner = valueNode.expression;
  }
  return inner.type === NODE_TYPES.Literal && typeof inner.value === 'string';
}

function findNanoIdPrefixProperty(classBody) {
  if (!classBody || !classBody.body) {
    return null;
  }
  for (const member of classBody.body) {
    if (member.type !== NODE_TYPES.PropertyDefinition) {
      continue;
    }
    if (!member.static) {
      continue;
    }
    if (getPropertyKeyName(member.key) !== 'nanoIdPrefix') {
      continue;
    }
    return member;
  }
  return null;
}

// eslint-disable-next-line import/no-commonjs
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Require model inheriting from ModelWithPublicId classes to declare `public static readonly nanoIdPrefix = '<prefix>' as const;`",
    },
    schema: [],
    messages: {
      missing:
        "Model inheriting from ModelWithPublicId must have: public static readonly nanoIdPrefix = '<prefix>' as const;",
      invalidValue:
        "nanoIdPrefix must be a string literal with 'as const' (e.g. public static readonly nanoIdPrefix = '<prefix>' as const;).",
    },
  },
  create(context) {
    return {
      ClassDeclaration(node) {
        if (!isSequelizeModelClass(node)) {
          return;
        }

        const nanoIdPrefixProp = findNanoIdPrefixProperty(node.body);

        if (!nanoIdPrefixProp) {
          context.report({
            node: node.id,
            messageId: 'missing',
          });
          return;
        }

        if (!isStringLiteralWithAsConst(nanoIdPrefixProp.value)) {
          context.report({
            node: nanoIdPrefixProp,
            messageId: 'invalidValue',
          });
        }
      },
    };
  },
};
