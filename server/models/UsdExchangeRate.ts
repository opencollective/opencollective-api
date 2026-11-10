import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

import sequelize, { DataTypes, Model, QueryTypes } from '../lib/sequelize';

type ExchangeRate = { from: string; to: string; rate: number };

/**
 * The rate from USD to each currency, one per currency and day (`UsdExchangeRates`). Every other
 * pair is computed from them: X -> Y = (USD -> Y) / (USD -> X), with the `fx_rate(from, to, at)`
 * SQL function in queries.
 *
 * `CurrencyExchangeRates` is deprecated: it used to store every pair, and is now a view computing
 * them from this table, kept only so that existing reports (Metabase) keep working. Don't use it in
 * the code. See migration 20261110150000.
 */
class UsdExchangeRate extends Model<InferAttributes<UsdExchangeRate>, InferCreationAttributes<UsdExchangeRate>> {
  public static readonly tableName = 'UsdExchangeRates' as const;

  declare public readonly id: CreationOptional<number>;
  declare public currency: string;
  declare public rate: number;
  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;

  /**
   * Stores rates from USD (`{ EUR: 0.92, ... }`). One rate per currency and day: a rate recorded
   * again the same day replaces the previous one if it's more recent.
   */
  static async record(rates: Record<string, number>, createdAt: Date = new Date()): Promise<void> {
    const currencies = Object.keys(rates);
    if (!currencies.length) {
      return;
    }

    await sequelize.query(
      `
      INSERT INTO "UsdExchangeRates" ("currency", "rate", "createdAt", "updatedAt")
      SELECT c.currency, c.rate, :createdAt, :createdAt
      FROM UNNEST(ARRAY[:currencies]::varchar[], ARRAY[:rates]::double precision[]) AS c(currency, rate)
      ON CONFLICT ("currency", "day") DO UPDATE
      SET "rate" = EXCLUDED."rate", "createdAt" = EXCLUDED."createdAt", "updatedAt" = EXCLUDED."updatedAt"
      WHERE EXCLUDED."createdAt" >= "UsdExchangeRates"."createdAt"
      `,
      { replacements: { currencies, rates: currencies.map(currency => rates[currency]), createdAt } },
    );
  }

  /**
   * The latest rate from `fromCurrency` to each of `toCurrencies` at `date`. Currencies without a
   * rate are left out.
   */
  static getMany(
    fromCurrency: string,
    toCurrencies: string[],
    date: string | Date = 'latest',
  ): Promise<ExchangeRate[]> {
    return sequelize.query<ExchangeRate>(
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
        replacements: { date: date === 'latest' ? new Date() : date, fromCurrency, toCurrencies },
      },
    );
  }

  /**
   * Standard deviation and latest value of the daily rate from `from` to `to` over the last 5 days.
   */
  static async getPairStats(
    from: string,
    to: string,
  ): Promise<{ from: string; to: string; stddev: number; latestRate: number }> {
    return sequelize.query<{ from: string; to: string; stddev: number | null; latestRate: number | null }>(
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
  }
}

UsdExchangeRate.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    currency: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    rate: {
      type: DataTypes.DOUBLE,
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
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'UsdExchangeRates',
  },
);

export default UsdExchangeRate;
