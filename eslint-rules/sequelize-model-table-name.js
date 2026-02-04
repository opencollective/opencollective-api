'use strict';

/**
 * Custom ESLint rule: sequelize-model/require-table-name
 *
 * Ensures every Sequelize model class (extends Model) has:
 *   public static readonly tableName = 'TableName' as const;
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
  const superClass = node.superClass;
  if (superClass.type === NODE_TYPES.Identifier) {
    return superClass.name === 'Model';
  }
  if (superClass.type === NODE_TYPES.MemberExpression) {
    const { object, property } = superClass;
    const objectName = object.type === NODE_TYPES.Identifier ? object.name : null;
    const propertyName = property.type === NODE_TYPES.Identifier ? property.name : null;
    return propertyName === 'Model' && (objectName === 'sequelize' || objectName === 'Sequelize');
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

function findTableNameProperty(classBody) {
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
    if (getPropertyKeyName(member.key) !== 'tableName') {
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
        "Require Sequelize model classes to declare `public static readonly tableName = 'TableName' as const;`",
    },
    schema: [],
    messages: {
      missing: "Sequelize model must have: public static readonly tableName = 'TableName' as const;",
      invalidValue:
        "tableName must be a string literal with 'as const' (e.g. public static readonly tableName = 'TableName' as const;).",
    },
  },
  create(context) {
    return {
      ClassDeclaration(node) {
        if (!isSequelizeModelClass(node)) {
          return;
        }

        const tableNameProp = findTableNameProperty(node.body);

        if (!tableNameProp) {
          context.report({
            node: node.id,
            messageId: 'missing',
          });
          return;
        }

        if (!isStringLiteralWithAsConst(tableNameProp.value)) {
          context.report({
            node: tableNameProp,
            messageId: 'invalidValue',
          });
        }
      },
    };
  },
};
