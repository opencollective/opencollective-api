import config from 'config';
import debugLib from 'debug';
import {
  Kysely,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryId,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely';
import { KyselySequelizeDialect } from 'kysely-sequelize';
import type { Model, ModelStatic } from 'sequelize';

import type { Database } from '../types/kysely-tables';
import { ViewsDatabase } from '../types/kysely-views';

import { reportErrorToSentry } from './sentry';
import sequelize from './sequelize';
import { parseToBoolean } from './utils';

const debug = debugLib('kysely');

function rowToModel<T extends Model>(row: object, ModelClass: ModelStatic<T>): T {
  const rawAttrs = ModelClass.rawAttributes;
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (Object.prototype.hasOwnProperty.call(rawAttrs, key)) {
      attrs[key] = row[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- building from plain Kysely row
  return ModelClass.build(attrs as any) as T;
}

/**
 * Returns a function that turns Kysely query rows into Sequelize model instances.
 * Use with .execute(): `.execute().then(kyselyToSequelizeModels(models.Collective))`
 *
 * Accepts a single row or an array of rows; returns a single instance or an array.
 * Instances are not persisted.
 */
export function kyselyToSequelizeModels<T extends Model>(ModelClass: ModelStatic<T>) {
  return function <R extends object[] | object>(rows: R): R extends unknown[] ? T[] : T {
    if (Array.isArray(rows)) {
      return rows.map(row => rowToModel(row, ModelClass)) as R extends unknown[] ? T[] : T;
    }
    return rowToModel(rows, ModelClass) as R extends unknown[] ? T[] : T;
  };
}

export type DatabaseWithViews = Database & ViewsDatabase;

let kyselyInstance: Kysely<DatabaseWithViews> | null = null;

/**
 * Shared mailbox between QueryOriginPlugin and QueryOriginCompiler.
 * Both methods receive the same QueryId object reference per execute() call —
 * transformQuery writes, compileQuery reads, both synchronously within compile().
 * WeakMap handles GC automatically when the QueryId is released.
 */
const queryOriginMap = new WeakMap<QueryId, string>();

export function getKysely(): Kysely<DatabaseWithViews> {
  if (!kyselyInstance) {
    const logQueryOrigin = parseToBoolean(config.database?.logQueryOrigin);
    kyselyInstance = new Kysely<DatabaseWithViews>({
      dialect: new KyselySequelizeDialect({
        sequelize,
        kyselySubDialect: {
          createAdapter: () => new PostgresAdapter(),
          createIntrospector: db => new PostgresIntrospector(db),
          createQueryCompiler: () => (logQueryOrigin ? new QueryOriginCompiler() : new PostgresQueryCompiler()),
        },
      }),
      plugins: logQueryOrigin ? [new QueryOriginPlugin()] : [],
      log: debug.enabled
        ? e => {
            if (e.level === 'query') {
              debug('Kysely query: %s\n\nParameters: %o', e.query.sql, e.query.parameters);
            } else {
              debug('Kysely error on query: %s\n\nParameters: %o', e.query.sql, e.query.parameters);
            }
          }
        : undefined,
    });
  }
  return kyselyInstance;
}

/**
 * Captures the call-site stack frame synchronously in transformQuery (which
 * runs before the first `await` in execute()) and stores it in queryOriginMap.
 * QueryOriginCompiler reads it in compileQuery — also synchronous, within the
 * same compile() call — and prepends it to the SQL string, so the comment
 * appears before WITH clauses and SELECT alike.
 */
class QueryOriginPlugin implements KyselyPlugin {
  private static readonly excludeLineTexts = [
    'node_modules',
    'node:internal',
    'internal/process',
    ' anonymous ',
    'runMicrotasks',
    'Promise.',
  ];

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    try {
      const o: { stack?: string } = {};
      Error.captureStackTrace(o, this.transformQuery);
      const lines = (o.stack ?? '').split(/\n/g).slice(1);
      const line = lines.find(l => !QueryOriginPlugin.excludeLineTexts.some(t => l.includes(t)));
      if (!line) {
        return args.node;
      }

      const methodAndPath = line.replace(/(\s+at (async )?|[^a-z0-9.:/\\\-_ ]|:\d+\)?$)/gi, '');
      if (methodAndPath) {
        queryOriginMap.set(args.queryId, `/* Kysely: ${methodAndPath} */`);
      }
    } catch (e) {
      reportErrorToSentry(e);
    }

    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

/**
 * Reads the comment stored by QueryOriginPlugin and prepends it to the
 * compiled SQL before it is sent to the driver.
 */
class QueryOriginCompiler extends PostgresQueryCompiler {
  override compileQuery(node: RootOperationNode, queryId: QueryId): ReturnType<PostgresQueryCompiler['compileQuery']> {
    const compiled = super.compileQuery(node, queryId);
    const comment = queryOriginMap.get(queryId);
    return comment ? { ...compiled, sql: `${comment} ${compiled.sql}` } : compiled;
  }
}
