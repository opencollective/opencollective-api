import { Association, IncludeOptions, Model, ModelAttributes, ModelStatic, Sequelize } from 'sequelize';

declare module 'sequelize' {
  interface CteOption {
    as: string;
    query: string;
  }

  interface QueryOptions {
    /** @experimental Use with caution. Not tested with all query types. */
    cte?: CteOption[];
  }

  interface CountOptions {
    /** @experimental Use with caution. Not tested with all query types. */
    cte?: CteOption[];
  }
}

//

/**
 * Adds a sequelize hook to prepend optional CTEs to a query.
 * CTEs can be added via the `cte` option in the query options.
 *
 */
export function sequelizeCte(sequelize: Sequelize) {
  sequelize.addHook('beforeQuery', (options, query) => {
    if (options.cte && options.cte.length > 0) {
      const queryGenerator = sequelize.getQueryInterface().queryGenerator as {
        quoteIdentifier: (identifier: string) => string;
      };
      const runFn = query['run'];
      (query as unknown)['run'] = async function (sql, bindParams) {
        const ctes = options.cte.map(cte => `${queryGenerator.quoteIdentifier(cte.as)} AS (${cte.query})`).join(', ');
        const result = await Reflect.apply(runFn, query, [`WITH ${ctes} ${sql}`, bindParams]);
        return result;
      };
    }
  });
}

/**
 * Adds a CTE to an include option.
 * Used to include a CTE in a query. CTEs are first added via the `cte` option in the query options.
 * @param tableName - The name of the CTE table
 * @param attributes - The attributes of the CTE table
 * @param leftModel - The model to join the CTE to
 * @param leftKey - The key on the left model to join the CTE to
 * @returns The include options for the CTE
 *
 * @example
 * ```typescript
 * const cte = [
 *   {
 *     query: 'SELECT "OrderId" as "id" FROM "Trasactions" t WHERE ...',
 *     as: 'TransactionsCTE',
 *   },
 * ];
 * const include = [
 *   includeCte('TransactionsCTE', {
 *     id: {
 *       type: DataTypes.INTEGER,
 *     },
 *   }, models.Order, 'id'),
 * ];
 *
 * models.Order.findAll({
 *   cte,
 *   include,
 * });
 * ```
 *
 * ```sql
 *
 * The query will be:
 * WITH "TransactionsCTE" AS (SELECT "OrderId" as "id" FROM "Trasactions" t WHERE ...)
 * SELECT * FROM "Orders"
 * INNER JOIN "TransactionsCTE" ON "Orders"."id" = "TransactionsCTE"."id"
 * ```
 */
export function includeCte(
  tableName: string,
  attributes: ModelAttributes<Model, unknown>,
  leftModel: ModelStatic<Model>,
  leftKey: string,
): IncludeOptions {
  return {
    as: tableName,
    association: {
      source: leftModel,
      identifierField: leftKey,
    } as unknown as Association<Model, Model>,
    _pseudo: true,
    required: true,
    model: {
      rawAttributes: attributes,
      getTableName: () => tableName,
      tableAttributes: Object.keys(attributes),
      _injectDependentVirtualAttributes: () => {
        return [];
      },
      primaryKeyAttribute: Object.entries(attributes).find(([, value]) => value['primaryKey'])?.[0] ?? 'id',
      _virtualAttributes: new Set(),
      options: {
        paranoid: false,
      },
      _expandAttributes: options => {
        options.attributes = [];
      },
    } as unknown as ModelStatic<Model>,
  } as unknown as IncludeOptions;
}
