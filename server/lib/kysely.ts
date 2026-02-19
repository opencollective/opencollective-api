import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { KyselySequelizeDialect } from 'kysely-sequelize';
import type { Model, ModelStatic } from 'sequelize';

import type { Database } from '../types/kysely-tables';
import { ViewsDatabase } from '../types/kysely-views';

import sequelize from './sequelize';

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
 * Returns a singleton Kysely instance that uses the existing Sequelize
 * connection pool. Table and column names match the Sequelize models
 * (e.g. Collectives, camelCase columns).
 */
export function getKysely(): Kysely<DatabaseWithViews> {
  if (!kyselyInstance) {
    kyselyInstance = new Kysely<DatabaseWithViews>({
      log(event) {
        if (process.env.DEBUG_KYSELY === 'true') {
          if (event.level === 'error') {
            // eslint-disable-next-line no-console
            console.error('Query failed : ', {
              durationMs: event.queryDurationMillis,
              error: event.error,
              sql: event.query.sql,
              params: event.query.parameters,
            });
          } else {
            // eslint-disable-next-line no-console
            console.log('Query executed : ', {
              durationMs: event.queryDurationMillis,
              sql: event.query.sql,
              params: event.query.parameters,
            });
          }
        }
      },
      dialect: new KyselySequelizeDialect({
        sequelize,
        kyselySubDialect: {
          createAdapter: () => new PostgresAdapter(),
          createIntrospector: db => new PostgresIntrospector(db),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      }),
    });
  }
  return kyselyInstance;
}
