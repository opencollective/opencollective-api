import { Model } from 'sequelize';

import restoreSequelizeAttributesOnClass from '../lib/restore-sequelize-attributes-on-class';

export class GuestToken extends Model<GuestToken> {
  public readonly id!: number;
  public CollectiveId!: number;
  public value!: string;
  public createdAt!: Date;
  public updatedAt!: Date;

  constructor(...args) {
    super(...args);
    restoreSequelizeAttributesOnClass(new.target, this);
  }
}

export default (sequelize, DataTypes): typeof GuestToken => {
  // Link the model to database fields
  GuestToken.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      CollectiveId: {
        type: DataTypes.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        allowNull: false,
        unique: true,
      },
      value: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
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
      deletedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      sequelize,
      tableName: 'GuestTokens',
    },
  );

  return GuestToken;
};
