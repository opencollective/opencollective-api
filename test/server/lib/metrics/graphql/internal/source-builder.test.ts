import { expect } from 'chai';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLField,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLNullableType,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLType,
} from 'graphql';

import { GraphQLAccount } from '../../../../../../server/graphql/v2/interface/Account';
import { GraphQLAmount } from '../../../../../../server/graphql/v2/object/Amount';
import { type MetricSource } from '../../../../../../server/lib/metrics';
import {
  buildSourceField,
  GraphQLMetricsAccountReferenceFilter,
  GraphQLMetricsHavingOp,
  GraphQLMetricsIntFilter,
  GraphQLMetricsOrderByDirection,
  GraphQLMetricsResult,
  GraphQLMetricsStringFilter,
} from '../../../../../../server/lib/metrics/graphql';

/**
 * Schema-shape tests for the source-builder. Uses a synthetic `MetricSource`
 * exercising every dimension kind / reference / measure kind so we can read
 * the generated GraphQL types back and assert on their structure without
 * touching the DB.
 */

// A synthetic source. Cast to `MetricSource` because the relation name is not
// in the real Kysely DB type — that's fine for schema-shape tests.
const TestSource = {
  kind: 'dense',
  relation: 'TestRelation',
  dateColumn: 'day',
  dimensions: {
    hostCollectiveId: {
      name: 'host',
      column: 'HostCollectiveId',
      kind: 'account',
    },
    collectiveId: {
      name: 'collective',
      column: 'CollectiveId',
      kind: 'account',
    },
    collectiveType: {
      name: 'collectiveType',
      column: 'collectiveType',
      kind: 'enum',
    },
    hostCurrency: {
      name: 'hostCurrency',
      column: 'hostCurrency',
      kind: 'string',
    },
    isMainAccount: {
      name: 'isMainAccount',
      expression: '("ParentCollectiveId" IS NULL)',
      kind: 'boolean',
    },
    rawIntDim: {
      name: 'rawIntDim',
      column: 'someInt',
      kind: 'int',
    },
  },
  measures: {
    incomeAmount: {
      name: 'incomeAmount',
      aggregation: 'SUM("incomeAmount")',
      kind: 'amount',
      currencyColumn: 'hostCurrency',
      description: 'Income amount',
    },
    transactionCount: {
      name: 'transactionCount',
      aggregation: 'SUM("transactionCount")',
      kind: 'count',
    },
    avgRatio: {
      name: 'avgRatio',
      aggregation: 'AVG("ratio")',
      kind: 'number',
    },
  },
} as unknown as MetricSource;

const PREFIX = 'TestMetric';

function unwrapNonNull<T extends GraphQLNullableType>(type: GraphQLNonNull<T> | T): T {
  return type instanceof GraphQLNonNull ? type.ofType : type;
}

/** Unwrap `NonNull<List<NonNull<X>>>` (a list of non-null Xs) down to the element type. */
function unwrapNonNullListItem<T extends GraphQLNullableType>(type: GraphQLNonNull<GraphQLList<GraphQLNonNull<T>>>): T {
  return type.ofType.ofType.ofType;
}

describe('server/lib/metrics/graphql/source-builder', () => {
  describe('buildSourceField — generated schema shapes', () => {
    const field = buildSourceField({
      source: TestSource,
      schemaPrefix: PREFIX,
      description: 'Test metric description',
    });

    it('returns a NonNull result type wrapping the generated MetricsResult', () => {
      expect(field.type).to.be.instanceOf(GraphQLNonNull);
      const inner = unwrapNonNull(field.type);
      expect(inner).to.be.instanceOf(GraphQLObjectType);
      expect((inner as GraphQLObjectType).name).to.equal(`${PREFIX}MetricsResult`);
      expect(field.description).to.equal('Test metric description');
    });

    it('exposes a single `input` argument that is a NonNull main input', () => {
      const inputArg = field.args!.input;
      expect(inputArg).to.exist;
      expect(inputArg.type).to.be.instanceOf(GraphQLNonNull);
      const inner = unwrapNonNull(inputArg.type as GraphQLType);
      expect(inner).to.be.instanceOf(GraphQLInputObjectType);
      expect((inner as GraphQLInputObjectType).name).to.equal(`${PREFIX}MetricsInput`);
    });

    describe('measure enum', () => {
      const inputArg = field.args!.input;
      const main = unwrapNonNull(inputArg.type as GraphQLType) as GraphQLInputObjectType;
      const measureEnum = unwrapNonNullListItem(
        main.getFields().measures.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLEnumType>>>,
      );

      it('has stable name and includes every measure', () => {
        expect(measureEnum.name).to.equal(`${PREFIX}MetricsMeasure`);
        const names = measureEnum.getValues().map(v => v.name);
        expect(names).to.have.members(['incomeAmount', 'transactionCount', 'avgRatio']);
      });

      it('preserves measure descriptions on enum values', () => {
        const income = measureEnum.getValue('incomeAmount');
        expect(income?.description).to.equal('Income amount');
      });
    });

    describe('dimension enum (used by groupBy)', () => {
      const inputArg = field.args!.input;
      const main = unwrapNonNull(inputArg.type as GraphQLType) as GraphQLInputObjectType;
      const dimEnum = unwrapNonNull(
        (main.getFields().groupBy.type as GraphQLList<GraphQLType>).ofType,
      ) as GraphQLEnumType;

      it('has stable name', () => {
        expect(dimEnum.name).to.equal(`${PREFIX}MetricsDimension`);
      });

      it('uses reference alias names when set, raw name otherwise', () => {
        const names = dimEnum.getValues().map(v => v.name);
        // host / collective come from references.as
        // collectiveType / hostCurrency / isMainAccount / rawIntDim use raw names
        expect(names).to.have.members([
          'host',
          'collective',
          'collectiveType',
          'hostCurrency',
          'isMainAccount',
          'rawIntDim',
        ]);
      });
    });

    describe('filters input', () => {
      const inputArg = field.args!.input;
      const main = unwrapNonNull(inputArg.type as GraphQLType) as GraphQLInputObjectType;
      const filtersInput = main.getFields().filters.type as GraphQLInputObjectType;

      it('has stable name', () => {
        // Reserves the un-suffixed name for a future recursive `MetricsFilter` (boolean tree of leaves).
        expect(filtersInput.name).to.equal(`${PREFIX}MetricsFiltersAllOf`);
      });

      it('maps each dimension kind to the right filter type', () => {
        const fields = filtersInput.getFields();
        // Account-reference dimensions get the AccountReferenceFilter input
        expect(fields.host.type).to.equal(GraphQLMetricsAccountReferenceFilter);
        expect(fields.collective.type).to.equal(GraphQLMetricsAccountReferenceFilter);
        // Plain int dimension → IntFilter
        expect(fields.rawIntDim.type).to.equal(GraphQLMetricsIntFilter);
        // String / enum / date → StringFilter
        expect(fields.collectiveType.type).to.equal(GraphQLMetricsStringFilter);
        expect(fields.hostCurrency.type).to.equal(GraphQLMetricsStringFilter);
        // Boolean dimension → plain GraphQLBoolean
        expect(fields.isMainAccount.type).to.equal(GraphQLBoolean);
      });
    });

    describe('group output type', () => {
      const resultType = unwrapNonNull(field.type) as GraphQLObjectType;
      const rowType = unwrapNonNullListItem(
        resultType.getFields().rows.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>,
      );
      const groupType = rowType.getFields().group.type as GraphQLObjectType;

      it('has stable name', () => {
        expect(groupType.name).to.equal(`${PREFIX}MetricsGroup`);
      });

      it('resolves Account-reference dimensions to the GraphQLAccount interface', () => {
        const fields = groupType.getFields();
        expect(fields.host.type).to.equal(GraphQLAccount);
        expect(fields.collective.type).to.equal(GraphQLAccount);
      });

      it('uses scalar types for non-reference dimensions', () => {
        const fields = groupType.getFields();
        expect(fields.rawIntDim.type).to.equal(GraphQLInt);
        expect(fields.collectiveType.type).to.equal(GraphQLString);
        expect(fields.hostCurrency.type).to.equal(GraphQLString);
        expect(fields.isMainAccount.type).to.equal(GraphQLBoolean);
      });

      it('Account dimension resolver loads the entity via req.loaders', async () => {
        const hostField = groupType.getFields().host as GraphQLField<unknown, unknown>;
        const fakeAccount = { id: 999, slug: 'fake' };
        const loaded: number[] = [];
        const fakeReq = {
          loaders: {
            Collective: {
              byId: {
                load: (id: number) => {
                  loaded.push(id);
                  return Promise.resolve(fakeAccount);
                },
              },
            },
          },
        };
        const row = { group: { host: 42 }, values: {} };
        const resolved = await hostField.resolve!(row, {}, fakeReq, {} as any);
        expect(loaded).to.deep.equal([42]);
        expect(resolved).to.equal(fakeAccount);
      });

      it('Account dimension resolver returns null when the group value is null', async () => {
        const hostField = groupType.getFields().host as GraphQLField<unknown, unknown>;
        const row = { group: { host: null }, values: {} };
        const resolved = await hostField.resolve!(row, {}, {} as any, {} as any);
        expect(resolved).to.equal(null);
      });
    });

    describe('values output type', () => {
      const resultType = unwrapNonNull(field.type) as GraphQLObjectType;
      const rowType = unwrapNonNullListItem(
        resultType.getFields().rows.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>,
      );
      const valuesField = rowType.getFields().values;
      const valuesType = unwrapNonNull(valuesField.type) as GraphQLObjectType;

      it('has stable name and is wrapped in NonNull on the row', () => {
        expect(valuesField.type).to.be.instanceOf(GraphQLNonNull);
        expect(valuesType.name).to.equal(`${PREFIX}MetricsValues`);
      });

      it('maps each measure kind to the right scalar', () => {
        const fields = valuesType.getFields();
        expect(fields.incomeAmount.type).to.equal(GraphQLAmount);
        expect(fields.transactionCount.type).to.equal(GraphQLInt);
        expect(fields.avgRatio.type).to.equal(GraphQLFloat);
      });

      it('amount measure resolver returns { value, currency } from the row', () => {
        const incomeField = valuesType.getFields().incomeAmount;
        const row = { values: { incomeAmount: 12345 }, currency: 'USD' };
        const resolved = incomeField.resolve!(row, {}, {} as any, {} as any);
        expect(resolved).to.deep.equal({ value: 12345, currency: 'USD' });
      });

      it('non-amount measure resolver returns the raw value (or null)', () => {
        const countField = valuesType.getFields().transactionCount;
        expect(countField.resolve!({ values: { transactionCount: 7 } }, {}, {} as any, {} as any)).to.equal(7);
        expect(countField.resolve!({ values: {} }, {}, {} as any, {} as any)).to.equal(null);
      });
    });

    describe('result type', () => {
      const resultType = unwrapNonNull(field.type) as GraphQLObjectType;

      it('implements the MetricsResult interface', () => {
        expect(resultType.getInterfaces()).to.include(GraphQLMetricsResult);
      });

      it('has the canonical envelope fields', () => {
        const fields = resultType.getFields();
        expect(Object.keys(fields)).to.include.members(['dateFrom', 'dateTo', 'bucket', 'groupBy', 'rows']);
      });

      it('does not expose the internal source / relation name', () => {
        // The relation name is an internal identity; nothing about it should leak through GraphQL.
        const fields = resultType.getFields();
        expect(Object.keys(fields)).to.not.include('source');
      });

      it('uppercases the bucket on the way out', () => {
        const bucketField = resultType.getFields().bucket;
        expect(bucketField.resolve!({ bucket: 'month' }, {}, {} as any, {} as any)).to.equal('MONTH');
        expect(bucketField.resolve!({}, {}, {} as any, {} as any)).to.equal(null);
      });

      it('isTypeOf matches values stamped with this prefix (and rejects raw relation-named results)', () => {
        // The discriminator is a per-buildSourceField stamp set by the resolver,
        // NOT the source.relation — so the schema can stay decoupled from the
        // physical relation name.
        const stampKey = '__metricsResultType';
        const stampValue = `${PREFIX}MetricsResult`;
        expect(resultType.isTypeOf!({ [stampKey]: stampValue } as never, {} as any, {} as any)).to.equal(true);
        expect(resultType.isTypeOf!({ [stampKey]: 'OtherMetricsResult' } as never, {} as any, {} as any)).to.equal(
          false,
        );
        // A bare `source: 'TestRelation'` payload (the OLD discriminator) should NOT match.
        expect(resultType.isTypeOf!({ source: 'TestRelation' } as never, {} as any, {} as any)).to.equal(false);
        expect(resultType.isTypeOf!(null as never, {} as any, {} as any)).to.equal(false);
      });
    });

    describe('main input shape', () => {
      const inputArg = field.args!.input;
      const main = unwrapNonNull(inputArg.type as GraphQLType) as GraphQLInputObjectType;
      const fields = main.getFields();

      it('has the canonical input fields', () => {
        expect(Object.keys(fields)).to.include.members([
          'dateRange',
          'measures',
          'filters',
          'bucket',
          'groupBy',
          'having',
          'orderBy',
          'limit',
          'timezone',
        ]);
      });

      it('marks dateRange and measures as NonNull, leaves the rest optional', () => {
        expect(fields.dateRange.type).to.be.instanceOf(GraphQLNonNull);
        expect(fields.measures.type).to.be.instanceOf(GraphQLNonNull);
        expect(fields.filters.type).to.not.be.instanceOf(GraphQLNonNull);
        expect(fields.bucket.type).to.not.be.instanceOf(GraphQLNonNull);
        expect(fields.groupBy.type).to.not.be.instanceOf(GraphQLNonNull);
      });

      it('having is a list of HavingInput (each requires a measure / op / value)', () => {
        // Schema: `having: [HavingInput!]` — multiple AND-combined predicates.
        const havingListType = fields.having.type as GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>;
        expect(havingListType).to.be.instanceOf(GraphQLList);
        const havingInput = havingListType.ofType.ofType;
        expect(havingInput.name).to.equal(`${PREFIX}MetricsHavingInput`);
        const hf = havingInput.getFields();
        expect(hf.measure.type).to.be.instanceOf(GraphQLNonNull);
        expect(unwrapNonNull(hf.op.type)).to.equal(GraphQLMetricsHavingOp);
        expect(unwrapNonNull(hf.value.type)).to.equal(GraphQLFloat);
      });

      it('orderBy is a list of OrderByInput (each requires a measure + direction)', () => {
        // Schema: `orderBy: [OrderByInput!]` — first is primary, rest are tiebreakers.
        const orderByListType = fields.orderBy.type as GraphQLList<GraphQLNonNull<GraphQLInputObjectType>>;
        expect(orderByListType).to.be.instanceOf(GraphQLList);
        const orderByInput = orderByListType.ofType.ofType;
        expect(orderByInput.name).to.equal(`${PREFIX}MetricsOrderByInput`);
        const of = orderByInput.getFields();
        expect(of.measure.type).to.be.instanceOf(GraphQLNonNull);
        expect(unwrapNonNull(of.direction.type)).to.equal(GraphQLMetricsOrderByDirection);
      });

      it('timezone defaults to UTC', () => {
        expect(fields.timezone.defaultValue).to.equal('UTC');
        expect(fields.timezone.type).to.equal(GraphQLString);
      });
    });
  });

  describe('bindFromParent — bound dimensions are hidden from the schema', () => {
    const field = buildSourceField<{ id: number }>({
      source: TestSource,
      schemaPrefix: 'BoundTest',
      bindFromParent: {
        host: parent => parent.id,
      },
    });
    const inputArg = field.args!.input;
    const main = unwrapNonNull(inputArg.type as GraphQLType) as GraphQLInputObjectType;

    it('omits the bound dimension from the dimension enum', () => {
      const dimEnum = unwrapNonNull(
        (main.getFields().groupBy.type as GraphQLList<GraphQLType>).ofType,
      ) as GraphQLEnumType;
      const names = dimEnum.getValues().map(v => v.name);
      expect(names).to.not.include('host');
      expect(names).to.include('collective');
    });

    it('omits the bound dimension from the filters input', () => {
      const filtersInput = main.getFields().filters.type as GraphQLInputObjectType;
      expect(Object.keys(filtersInput.getFields())).to.not.include('host');
      expect(Object.keys(filtersInput.getFields())).to.include('collective');
    });

    it('omits the bound dimension from the group output type', () => {
      const resultType = unwrapNonNull(field.type) as GraphQLObjectType;
      const rowType = unwrapNonNullListItem(
        resultType.getFields().rows.type as GraphQLNonNull<GraphQLList<GraphQLNonNull<GraphQLObjectType>>>,
      );
      const groupType = rowType.getFields().group.type as GraphQLObjectType;
      expect(Object.keys(groupType.getFields())).to.not.include('host');
      expect(Object.keys(groupType.getFields())).to.include('collective');
    });
  });
});
