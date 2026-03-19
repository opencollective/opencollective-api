'use strict';

/**
 * Custom ESLint rule: sequelize-model/require-public-id-prefix
 *
 * Ensures every Sequelize model class (extends ModelWithPublicId) has:
 *   public static readonly nanoIdPrefix = EntityShortIdPrefix.<ModelName>;
 * (reference to the const from server/lib/permalink/entity-map.ts)
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

const ENTITY_SHORT_ID_PREFIX = 'EntityShortIdPrefix';

/**
 * Returns true when value is a reference to EntityShortIdPrefix.<Key>
 * (the const from entity-map), which preserves the literal type like `as const`.
 */
function isEntityShortIdPrefixReference(valueNode) {
  if (!valueNode) {
    return false;
  }
  if (valueNode.type !== NODE_TYPES.MemberExpression) {
    return false;
  }
  const obj = valueNode.object;
  const prop = valueNode.property;
  const objectName = obj.type === NODE_TYPES.Identifier ? obj.name : null;
  const propertyName = prop.type === NODE_TYPES.Identifier ? prop.name : null;
  return objectName === ENTITY_SHORT_ID_PREFIX && typeof propertyName === 'string';
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
        'Require model inheriting from ModelWithPublicId classes to declare nanoIdPrefix by referencing EntityShortIdPrefix from entity-map (e.g. public static readonly nanoIdPrefix = EntityShortIdPrefix.ModelName;).',
    },
    schema: [],
    messages: {
      missing:
        'Model inheriting from ModelWithPublicId must have: public static readonly nanoIdPrefix = EntityShortIdPrefix.<ModelName>;',
      invalidValue:
        'nanoIdPrefix must reference EntityShortIdPrefix from entity-map (e.g. public static readonly nanoIdPrefix = EntityShortIdPrefix.ModelName;).',
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

        if (!isEntityShortIdPrefixReference(nanoIdPrefixProp.value)) {
          context.report({
            node: nanoIdPrefixProp,
            messageId: 'invalidValue',
          });
        }
      },
    };
  },
};
