/**
 * The cost analyzer multiplies the children of a list by its `limit`, or by the `listSize` it declares in
 * `extensions.cost`. A list with neither counts as a single item, so every list of objects in the V2 schema must
 * declare one of them.
 *
 * GraphQL V1 is not checked: per-field costs are for V2 only (see opencollective/opencollective#9079). V1 fields
 * that take a `limit` without a default count as `DEFAULT_MAX_LIMIT` items.
 */
import { expect } from 'chai';
import type { FieldNode, GraphQLField, GraphQLInterfaceType, GraphQLObjectType, GraphQLSchema } from 'graphql';
import {
  buildSchema,
  getNamedType,
  getNullableType,
  isCompositeType,
  isInterfaceType,
  isListType,
  isObjectType,
  Kind,
} from 'graphql';

import { getFieldCostExtension, PARENT_LIMIT } from '../../../../server/graphql/cost/extensions';
import { resolveLimitArgument } from '../../../../server/graphql/cost/limit';
import schemaV2 from '../../../../server/graphql/v2/schema';

type AnyField = GraphQLField<unknown, unknown>;

/** A type holding a page of items, like `AccountCollection`. Its `nodes` take the size of the field returning it. */
const isCollectionType = (type: unknown): type is GraphQLObjectType | GraphQLInterfaceType => {
  if (!isObjectType(type) && !isInterfaceType(type)) {
    return false;
  }
  const nodes = type.getFields().nodes;
  return Boolean(nodes) && isListType(getNullableType(nodes.type));
};

/** A collection that is never paginated, like a time series, can declare the size on its `nodes` */
const hasSizedNodes = (type: GraphQLObjectType | GraphQLInterfaceType): boolean =>
  getFieldCostExtension(type.getFields().nodes as AnyField).listSize !== undefined;

const hasLimitDefault = (field: AnyField, limitArgument: AnyField['args'][number]): boolean => {
  // Resolving the limit of a field node without arguments falls back to the schema default, if any
  const fieldNode: FieldNode = { kind: Kind.FIELD, name: { kind: Kind.NAME, value: field.name } };
  return resolveLimitArgument(fieldNode, limitArgument).source === 'schemaDefault';
};

/** Returns the problems of a field, if any */
const getFieldProblems = (field: AnyField, parentIsCollection: boolean): string[] => {
  const limitArgument = field.args.find(arg => arg.name === 'limit');
  const { listSize } = getFieldCostExtension(field);
  const rawListSize = (field.extensions?.cost as Record<string, unknown> | undefined)?.listSize;
  const problems: string[] = [];

  if (rawListSize !== undefined && listSize === undefined) {
    problems.push(`has an invalid listSize (${JSON.stringify(rawListSize)})`);
  }

  if (limitArgument) {
    if (!hasLimitDefault(field, limitArgument)) {
      problems.push('takes a `limit` without a default value');
    }
    if (rawListSize !== undefined) {
      problems.push('takes a `limit` and declares a listSize, which is ignored');
    }
    return problems;
  }

  const returnType = getNamedType(field.type);
  if (!isCompositeType(returnType) || rawListSize !== undefined) {
    return problems;
  }

  if (isListType(getNullableType(field.type))) {
    // The items of a page take the limit of the field returning the collection
    if (!(parentIsCollection && field.name === 'nodes')) {
      problems.push('returns a list of objects without a `limit` argument or a listSize');
    }
  } else if (isCollectionType(returnType) && !hasSizedNodes(returnType)) {
    problems.push(
      `returns a collection without a \`limit\` argument or a listSize (use \`${PARENT_LIMIT}\` if it is a page of the parent)`,
    );
  }

  return problems;
};

const getSchemaProblems = (schema: GraphQLSchema): string[] => {
  const problems: string[] = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || (!isObjectType(type) && !isInterfaceType(type))) {
      continue;
    }

    const parentIsCollection = isCollectionType(type);
    for (const field of Object.values(type.getFields())) {
      for (const problem of getFieldProblems(field as AnyField, parentIsCollection)) {
        problems.push(`${type.name}.${field.name} ${problem}`);
      }
    }
  }

  return problems.sort();
};

describe('server/graphql/cost list sizes', () => {
  it('names the fields that have no size', () => {
    const schema = buildSchema(/* GraphQL */ `
      type Item {
        id: ID
        tags: [String]
      }
      type ItemCollection {
        totalCount: Int
        nodes: [Item]
        related: [Item]
      }
      type Query {
        items(limit: Int! = 10): ItemCollection
        itemsWithoutDefault(limit: Int): [Item]
        allItems: [Item]
        itemCollection: ItemCollection
        item: Item
      }
    `);

    expect(getSchemaProblems(schema)).to.deep.eq([
      'ItemCollection.related returns a list of objects without a `limit` argument or a listSize',
      `Query.allItems returns a list of objects without a \`limit\` argument or a listSize`,
      `Query.itemCollection returns a collection without a \`limit\` argument or a listSize (use \`${PARENT_LIMIT}\` if it is a page of the parent)`,
      'Query.itemsWithoutDefault takes a `limit` without a default value',
    ]);
  });

  it('every list of objects in the V2 schema has a limit with a default or a declared size', () => {
    expect(getSchemaProblems(schemaV2)).to.deep.eq([]);
  });
});
