import { Model } from 'sequelize';

import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';

/**
 * Sequelize model to represent an CurrencyExchangeRate, linked to the `CurrencyExchangeRates` table.
 */
export class CurrencyExchangeRate extends Model<CurrencyExchangeRate> {
  public readonly id!: number;
  public rate!: number;
  public from!: string;
  public to!: string;
  public createdAt!: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }
}

export default (sequelize, DataTypes): typeof CurrencyExchangeRate => {
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

  return CurrencyExchangeRate;
};
