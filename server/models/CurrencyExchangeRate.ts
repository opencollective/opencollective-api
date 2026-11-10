import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

import sequelize, { DataTypes, Model, QueryTypes } from '../lib/sequelize';

export enum FX_RATE_SOURCE {
  OPENCOLLECTIVE = 'OPENCOLLECTIVE',
  PAYPAL = 'PAYPAL',
  WISE = 'WISE',
  USER = 'USER',
}

/**
 * Sequelize model to represent an CurrencyExchangeRate, linked to the `CurrencyExchangeRates` view.
 * Only the rates from USD are stored (`UsdExchangeRates`): the view computes the other pairs for
 * reports, and its triggers store inserted USD -> X and X -> USD rates. API queries use the
 * `fx_rate(from, to, at)` SQL function instead of the view (see migration 20261110150000).
 */
class CurrencyExchangeRate extends Model<
  InferAttributes<CurrencyExchangeRate>,
  InferCreationAttributes<CurrencyExchangeRate>
> {
  public static readonly tableName = 'CurrencyExchangeRates' as const;

  declare public readonly id: CreationOptional<number>;
  declare public rate: number;
  declare public from: string;
  declare public to: string;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date;

  /**
   * The latest rate from `fromCurrency` to each of `toCurrencies` at `date`, computed from the rates
   * from USD (see `fx_rate`). Currencies without a rate are left out.
   */
  static getMany(
    fromCurrency: string,
    toCurrencies: string[],
    date: string | Date = 'latest',
  ): Promise<CurrencyExchangeRate[]> {
    return sequelize.query(
      `
      SELECT *
      FROM (
        SELECT :fromCurrency AS "from", c.currency AS "to", fx_rate(:fromCurrency, c.currency, :date) AS "rate"
        FROM UNNEST(ARRAY[:toCurrencies]::varchar[]) AS c(currency)
      ) r
      WHERE r."rate" IS NOT NULL
      ORDER BY r."to"
    `,
      {
        type: QueryTypes.SELECT,
        model: CurrencyExchangeRate,
        mapToModel: true,
        replacements: {
          date: date === 'latest' ? new Date() : date,
          fromCurrency,
          toCurrencies,
        },
      },
    );
  }

  /**
   * Standard deviation and latest value of the daily rate from `from` to `to` over the last 5 days,
   * computed from the rates from USD of each day.
   */
  static async getPairStats(
    from: string,
    to: string,
  ): Promise<{ from: string; to: string; stddev: number; latestRate: number }> {
    const info = sequelize.query<{ from: string; to: string; stddev: number | null; latestRate: number | null }>(
      `
        SELECT
          :from AS "from",
          :to AS "to",
          STDDEV(t."rate" / f."rate") AS "stddev",
          (ARRAY_AGG(t."rate" / f."rate" ORDER BY t."createdAt" DESC))[1] AS "latestRate"
        FROM "UsdExchangeRates" t
        INNER JOIN "UsdExchangeRates" f ON f."currency" = :from AND f."day" = t."day"
        WHERE t."currency" = :to
        AND t."createdAt" >= DATE_TRUNC('day', NOW() - INTERVAL '5 days')
        HAVING COUNT(*) > 0
      `,
      { type: QueryTypes.SELECT, raw: true, plain: true, replacements: { from, to } },
    );
    return info;
  }
}

// Link the model to database fields
CurrencyExchangeRate.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    rate: {
      type: DataTypes.FLOAT,
      allowNull: false,
    },
    from: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    to: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      allowNull: false,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
  },
  {
    sequelize,
    tableName: 'CurrencyExchangeRates',
  },
);

export default CurrencyExchangeRate;
