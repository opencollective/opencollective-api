/**
 * Argument-dependent costs: `extensions.cost.weight` and `extensions.cost.listSize` as functions of the arguments.
 * See opencollective/opencollective#9088.
 */
import { expect } from 'chai';
import type { FieldNode, OperationDefinitionNode } from 'graphql';
import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
  validate,
} from 'graphql';

import type { QueryCostOptions } from '../../../../server/graphql/cost';
import { getQueryCost } from '../../../../server/graphql/cost';
import { getTimeSeriesListSize } from '../../../../server/graphql/cost/argument-costs';
import { resolveFieldArguments } from '../../../../server/graphql/cost/arguments';
import { CostTier, getFieldCostExtension, MAX_COST_TIER } from '../../../../server/graphql/cost/extensions';
import { DEFAULT_MAX_LIMIT } from '../../../../server/graphql/cost/limit';
import schemaV2 from '../../../../server/graphql/v2/schema';

const Period = new GraphQLEnumType({ name: 'Period', values: { DAY: { value: 'day' }, YEAR: { value: 'year' } } });
const Filter = new GraphQLInputObjectType({
  name: 'Filter',
  fields: { slug: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) } },
});
const Point = new GraphQLObjectType({ name: 'Point', fields: { id: { type: GraphQLID } } });

const stats = {
  type: GraphQLInt,
  args: {
    includeChildren: { type: GraphQLBoolean, defaultValue: false },
    searchTerm: { type: GraphQLString },
  },
  extensions: {
    cost: {
      weight: args =>
        args.includeChildren === true || typeof args.searchTerm === 'string' ? CostTier.Aggregate : CostTier.Query,
    },
  },
};

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      stats,
      // Expensive by default
      fullStats: { ...stats, args: { ...stats.args, includeChildren: { type: GraphQLBoolean, defaultValue: true } } },
      series: {
        type: new GraphQLList(Point),
        args: { period: { type: Period, defaultValue: 'year' }, count: { type: GraphQLInt } },
        extensions: {
          cost: {
            listSize: args => (args.period === 'DAY' ? 30 : typeof args.count === 'number' ? args.count : 3),
          },
        },
      },
      throwing: {
        type: GraphQLInt,
        args: { value: { type: GraphQLString } },
        extensions: {
          cost: {
            weight: () => {
              throw new Error('Broken cost function');
            },
          },
        },
      },
      invalidWeight: { type: GraphQLInt, extensions: { cost: { weight: () => -1 } } },
      throwingList: {
        type: new GraphQLList(Point),
        extensions: {
          cost: {
            maxLimit: 42,
            listSize: () => {
              throw new Error('Broken list size');
            },
          },
        },
      },
      echo: {
        type: GraphQLInt,
        args: {
          filter: { type: Filter },
          period: { type: Period, defaultValue: 'day' },
          flag: { type: GraphQLBoolean },
          unset: { type: GraphQLString },
        },
      },
    },
  }),
});

const getResult = (query: string, options: QueryCostOptions = {}, targetSchema = schema) => {
  const document = parse(query);
  expect(validate(targetSchema, document).map(error => error.message)).to.deep.eq([]);
  const result = getQueryCost(targetSchema, document, options);
  expect(result.error).to.be.undefined;
  return result;
};

const cost = (query: string, options: QueryCostOptions = {}) => getResult(query, options).cost;

describe('server/graphql/cost argument-dependent costs', () => {
  describe('weight functions', () => {
    it('cost more with the expensive argument, from a literal', () => {
      expect(cost('{ stats }')).to.eq(CostTier.Query);
      expect(cost('{ stats(includeChildren: false) }')).to.eq(CostTier.Query);
      expect(cost('{ stats(includeChildren: true) }')).to.eq(CostTier.Aggregate);
      expect(cost('{ stats(searchTerm: "foo") }')).to.eq(CostTier.Aggregate);
    });

    it('cost more with the expensive argument, from a variable', () => {
      const query = 'query ($children: Boolean) { stats(includeChildren: $children) }';
      expect(cost(query, { variables: { children: false } })).to.eq(CostTier.Query);
      expect(cost(query, { variables: { children: true } })).to.eq(CostTier.Aggregate);
      // A variable default, used when the variable is not provided
      const withDefault = 'query ($children: Boolean = true) { stats(includeChildren: $children) }';
      expect(cost(withDefault)).to.eq(CostTier.Aggregate);
      expect(cost(withDefault, { variables: { children: false } })).to.eq(CostTier.Query);
    });

    it('use the schema default when the argument is missing', () => {
      expect(cost('{ fullStats }')).to.eq(CostTier.Aggregate);
      expect(cost('{ fullStats(includeChildren: false) }')).to.eq(CostTier.Query);
      // A variable that is not provided and has no default leaves the argument unset
      expect(cost('query ($children: Boolean) { fullStats(includeChildren: $children) }')).to.eq(CostTier.Aggregate);
    });

    it('count each alias with its own arguments', () => {
      expect(cost('{ a: stats b: stats(includeChildren: true) }')).to.eq(CostTier.Query + CostTier.Aggregate);
    });
  });

  describe('list size functions', () => {
    it('size the list from the arguments', () => {
      // Schema default: an internal enum value, given to the function by name
      expect(cost('{ series { id } }')).to.eq(1 + 3);
      expect(cost('{ series(period: DAY) { id } }')).to.eq(1 + 30);
      expect(
        cost('query ($period: Period) { series(period: $period) { id } }', { variables: { period: 'DAY' } }),
      ).to.eq(1 + 30);
      expect(cost('{ series(count: 7) { id } }')).to.eq(1 + 7);
    });
  });

  describe('failing functions', () => {
    it('does not fail the analysis when a weight function throws, counts the highest tier and reports it', () => {
      const result = getResult('{ stats throwing(value: "x") }');
      expect(result.cost).to.eq(CostTier.Query + MAX_COST_TIER);
      expect(result.abortReason).to.be.undefined;
      expect(result.costFunctionErrors).to.deep.eq([
        {
          coordinate: 'Query.throwing',
          responseKey: 'throwing',
          property: 'weight',
          message: 'Threw: Broken cost function',
        },
      ]);
    });

    it('treats an invalid result as a failure', () => {
      const result = getResult('{ invalidWeight }');
      expect(result.cost).to.eq(MAX_COST_TIER);
      expect(result.costFunctionErrors).to.deep.eq([
        {
          coordinate: 'Query.invalidWeight',
          responseKey: 'invalidWeight',
          property: 'weight',
          message: 'Returned an invalid value: -1',
        },
      ]);
    });

    it('counts the maximum limit of the field when a list size function fails', () => {
      const result = getResult('{ throwingList { id } }');
      expect(result.cost).to.eq(1 + 42);
      expect(result.costFunctionErrors.map(error => error.property)).to.deep.eq(['listSize']);
    });

    it('reports a failure once per field of the document', () => {
      const result = getResult('fragment F on Query { throwing } { ...F ...F other: throwing }');
      expect(result.costFunctionErrors.map(error => error.responseKey)).to.deep.eq(['throwing', 'other']);
    });

    it('accepts functions in extensions.cost', () => {
      const field = (costExtension: unknown) =>
        ({ extensions: { cost: costExtension } }) as unknown as Parameters<typeof getFieldCostExtension>[0];
      const weight = () => 1;
      const listSize = () => 2;
      expect(getFieldCostExtension(field({ weight, listSize }))).to.deep.eq({ weight, listSize });
    });
  });

  describe('argument resolution', () => {
    const resolve = (query: string, options = {}) => {
      const operation = parse(query).definitions[0] as OperationDefinitionNode;
      const fieldNode = operation.selectionSet.selections[0] as FieldNode;
      const variableDefinitions = new Map(
        (operation.variableDefinitions ?? []).map(def => [def.variable.name.value, def]),
      );
      return resolveFieldArguments(fieldNode, schema.getQueryType().getFields().echo, {
        variableDefinitions,
        ...options,
      });
    };

    it('returns the values as sent by the client, with the schema defaults', () => {
      expect(resolve('{ echo(filter: { slug: "a", tags: ["x"] }, flag: true) }')).to.deep.eq({
        filter: { slug: 'a', tags: ['x'] },
        flag: true,
        period: 'DAY', // Schema default, by name
      });
      expect(resolve('{ echo(period: YEAR, flag: null) }')).to.deep.eq({ period: 'YEAR', flag: null });
    });

    it('replaces the variables nested in literals', () => {
      const query = 'query ($slug: String) { echo(filter: { slug: $slug }) }';
      expect(resolve(query, { variables: { slug: 'b' } })).to.deep.eq({ filter: { slug: 'b' }, period: 'DAY' });
    });

    it('takes variables as they are, without coercion', () => {
      const query = 'query ($filter: Filter, $flag: Boolean) { echo(filter: $filter, flag: $flag) }';
      expect(resolve(query, { variables: { filter: { tags: 'x' }, flag: 'yes' } })).to.deep.eq({
        filter: { tags: 'x' },
        flag: 'yes',
        period: 'DAY',
      });
    });

    it('ignores variables that are not an object', () => {
      expect(resolve('query ($flag: Boolean) { echo(flag: $flag) }', { variables: 'oops' })).to.deep.eq({
        period: 'DAY',
      });
    });
  });

  describe('time series sizes', () => {
    const size = getTimeSeriesListSize();

    it('counts one node per period in the range', () => {
      const range = { dateFrom: '2024-01-01T00:00:00Z', dateTo: '2024-12-31T00:00:00Z' };
      expect(size({ ...range, timeUnit: 'MONTH' })).to.eq(13);
      expect(size({ ...range, timeUnit: 'DAY' })).to.eq(365);
      expect(size({ ...range, timeUnit: 'YEAR' })).to.eq(1);
      // Picked by the resolver from the length of the range: months for a year
      expect(size(range)).to.eq(13);
      expect(size({ periodInMonths: 3, timeUnit: 'WEEK' })).to.eq(13);
    });

    it('assumes the oldest account when the start is unknown', () => {
      expect(size({ timeUnit: 'DAY' })).to.eq(DEFAULT_MAX_LIMIT);
      expect(size({ timeUnit: 'YEAR' })).to.be.within(10, 20);
      expect(size({})).to.eq(36);
    });

    it('accepts anything', () => {
      for (const args of [{ dateFrom: 'not a date' }, { dateFrom: {} }, { timeUnit: 42 }, { periodInMonths: '3' }]) {
        expect(size(args)).to.be.within(1, DEFAULT_MAX_LIMIT);
      }
      expect(getTimeSeriesListSize({ labels: 2 })({ dateFrom: '2024-01-01', dateTo: '2024-01-05' })).to.eq(8);
    });
  });

  describe('V2 schema', () => {
    const v2Cost = (query: string, variables = {}) => getResult(query, { variables }, schemaV2).cost;
    const accountStats = (args: string) => v2Cost(`{ account(slug: "x") { stats { ${args} } } }`);

    it('AccountStats amounts cost more when they miss the materialized views', () => {
      const amount = (args = '') => accountStats(`totalAmountReceived${args} { valueInCents }`);
      for (const args of [
        '(includeChildren: true)',
        '(dateFrom: "2024-01-01T00:00:00Z")',
        '(periodInMonths: 12)',
        '(kind: [CONTRIBUTION])',
      ]) {
        expect(amount(args) - amount(), args).to.eq(CostTier.Aggregate - CostTier.Query);
      }
      expect(amount('(includeChildren: false, kind: [])')).to.eq(amount());

      const query =
        'query ($children: Boolean) { account(slug: "x") { stats { balance(includeChildren: $children) { valueInCents } } } }';
      expect(v2Cost(query, { children: true }) - v2Cost(query, { children: false })).to.eq(
        CostTier.Aggregate - CostTier.Query,
      );
    });

    it('time series cost more as the range or the time unit grow', () => {
      const series = (args: string) => accountStats(`totalAmountReceivedTimeSeries(${args}) { nodes { date } }`);
      const year = 'dateFrom: "2024-01-01T00:00:00Z", dateTo: "2024-12-31T00:00:00Z"';
      expect(series(`${year}, timeUnit: DAY`)).to.be.greaterThan(series(`${year}, timeUnit: MONTH`));
      expect(series('dateFrom: "2020-01-01T00:00:00Z", timeUnit: MONTH')).to.be.greaterThan(
        series(`${year}, timeUnit: MONTH`),
      );

      const hostSeries = (args: string) =>
        v2Cost(`{ host(slug: "x") { hostMetricsTimeSeries(${args}) { totalReceived { nodes { date } } } } }`);
      expect(hostSeries(`${year}, timeUnit: DAY`)).to.be.greaterThan(hostSeries(`${year}, timeUnit: YEAR`));
    });

    it('HostStats amounts cost more with a date range', () => {
      const hostStats = (args = '') =>
        v2Cost(`{ host(slug: "x") { hostStats { totalAmountSpent${args} { valueInCents } } } }`);
      expect(hostStats('(dateFrom: "2024-01-01T00:00:00Z")') - hostStats()).to.eq(CostTier.Report - CostTier.Aggregate);
    });

    it('collections cost more with a search term', () => {
      for (const field of ['accounts', 'expenses', 'orders', 'transactions']) {
        const collection = (args: string) => v2Cost(`{ ${field}(limit: 10${args}) { totalCount } }`);
        expect(collection(', searchTerm: "foo"') - collection(''), field).to.eq(CostTier.Aggregate - CostTier.Query);
        expect(collection(', searchTerm: ""'), field).to.eq(collection(''));
      }
      const tagStats = (args = '') => v2Cost(`{ tagStats${args} { totalCount } }`);
      expect(tagStats('(searchTerm: "foo")') - tagStats()).to.eq(CostTier.Report - CostTier.Aggregate);
    });

    it('sizes the exchange rates from the requests', () => {
      const query =
        'query ($requests: [CurrencyExchangeRateRequest!]!) { currencyExchangeRate(requests: $requests) { value } }';
      const request = { fromCurrency: 'USD', toCurrency: 'EUR' };
      expect(v2Cost(query, { requests: [request] })).to.eq(1 + 1);
      expect(v2Cost(query, { requests: Array(500).fill(request) })).to.eq(1 + 500);
      expect(v2Cost(query)).to.eq(1 + 50);
    });

    it('sizes metrics rows from the input', () => {
      const query = `query ($input: HostedCollectivesFinancialActivityMetricsInput!) {
        host(slug: "x") { metrics { hostedCollectivesFinancialActivity(input: $input) { rows { bucket } } } }
      }`;
      const input = {
        dateRange: { from: '2024-01-01T00:00:00Z', to: '2024-12-31T00:00:00Z' },
        measures: ['amountReceived'],
      };
      const single = v2Cost(query, { input });
      expect(v2Cost(query, { input: { ...input, bucket: 'MONTH' } }) - single).to.eq(12);
      expect(v2Cost(query, { input: { ...input, groupBy: ['account'], limit: 20 } }) - single).to.eq(19);
      expect(v2Cost(query, { input: { ...input, groupBy: ['account'] } }) - single).to.eq(999);
      expect(v2Cost(query) - single).to.eq(999);
    });

    it('makes update audience stats free for no audience', () => {
      const audienceStats = (args = '') => v2Cost(`{ update(id: "x") { audienceStats${args} { total } } }`);
      expect(audienceStats('(audience: NO_ONE)')).to.be.lessThan(audienceStats('(audience: ALL)'));
      expect(audienceStats()).to.eq(audienceStats('(audience: ALL)'));
    });
  });
});
