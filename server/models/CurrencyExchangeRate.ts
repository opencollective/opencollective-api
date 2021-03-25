import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';
import sequelize, { DataTypes, Model } from '../lib/sequelize';

/**
 * Sequelize model to represent an CurrencyExchangeRate, linked to the `CurrencyExchangeRates` table.
 */
export class CurrencyExchangeRate extends Model {
  public readonly id!: number;
  public rate!: number;
  public from!: string;
  public to!: string;
  public createdAt!: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }

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
        type: sequelize.QueryTypes.SELECT,
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
}

function setupModel(CurrencyExchangeRate) {
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
}

// We're using the setupModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
setupModel(CurrencyExchangeRate);

export default CurrencyExchangeRate;
