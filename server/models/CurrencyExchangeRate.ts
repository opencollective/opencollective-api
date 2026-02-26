import type { CreationOptional, InferAttributes, InferCreationAttributes } from 'sequelize';

import sequelize, { DataTypes, QueryTypes } from '../lib/sequelize';

import { ModelWithPublicId } from './ModelWithPublicId';

export enum FX_RATE_SOURCE {
  OPENCOLLECTIVE = 'OPENCOLLECTIVE',
  PAYPAL = 'PAYPAL',
  WISE = 'WISE',
  USER = 'USER',
}

/**
 * Sequelize model to represent an CurrencyExchangeRate, linked to the `CurrencyExchangeRates` table.
 */
class CurrencyExchangeRate extends ModelWithPublicId<
  InferAttributes<CurrencyExchangeRate>,
  InferCreationAttributes<CurrencyExchangeRate>
> {
  public static readonly nanoIdPrefix = 'fxrate' as const;
  public static readonly tableName = 'CurrencyExchangeRates' as const;

  declare public readonly id: CreationOptional<number>;
  declare public readonly publicId: string;
  declare public rate: number;
  declare public from: string;
  declare public to: string;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt: Date;

  static getMany(
    fromCurrency: string,
    toCurrencies: string[],
    date: string | Date = 'latest',
  ): Promise<CurrencyExchangeRate[]> {
    return sequelize.query(
      `
      SELECT DISTINCT ON ("to") *
      FROM "CurrencyExchangeRates"
      WHERE "createdAt" <= :date
      AND "from" = :fromCurrency
      AND "to" IN (:toCurrencies)
      ORDER BY "to", "createdAt" DESC
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

  static async getPairStats(
    from: string,
    to: string,
  ): Promise<{ from: string; to: string; stddev: number; latestRate: number }> {
    const info = sequelize.query<{ from: string; to: string; stddev: number | null; latestRate: number | null }>(
      `
        SELECT "from", "to", STDDEV("rate"), (ARRAY_AGG("rate" ORDER BY "createdAt" DESC))[1] as "latestRate"
        FROM "CurrencyExchangeRates"
        WHERE "from" = :from AND "to" = :to AND "createdAt" >= DATE_TRUNC('day', NOW() - INTERVAL '5 days')
        GROUP BY "to", "from"
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
    publicId: {
      type: DataTypes.STRING,
      unique: true,
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
