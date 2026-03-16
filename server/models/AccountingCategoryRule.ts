import { CreationOptional, DataTypes, ForeignKey, InferAttributes, InferCreationAttributes, Model } from 'sequelize';

import {
  ContributionAccountingCategoryRulePredicate,
  validateAndNormalizeContributionAccountingCategoryRulePredicate,
} from '../lib/accounting/categorization/types';
import sequelize from '../lib/sequelize';

import AccountingCategory from './AccountingCategory';
import Collective from './Collective';

export class AccountingCategoryRule extends Model<
  InferAttributes<AccountingCategoryRule>,
  InferCreationAttributes<AccountingCategoryRule>
> {
  public static readonly tableName = 'AccountingCategoryRules' as const;
  declare id: CreationOptional<number>;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare AccountingCategoryId: ForeignKey<AccountingCategory['id']>;
  declare name: string;
  declare enabled: boolean;
  declare type: 'CONTRIBUTION';
  declare order: number;
  declare predicates: ContributionAccountingCategoryRulePredicate[];
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: CreationOptional<Date>;

  declare collective?: Collective;
  declare accountingCategory?: AccountingCategory;

  public static async getRulesForCollective(
    collectiveId: number,
    type: AccountingCategoryRule['type'],
  ): Promise<AccountingCategoryRule[]> {
    return AccountingCategoryRule.findAll({
      include: [
        {
          model: AccountingCategory,
          as: 'accountingCategory',
        },
      ],
      where: { CollectiveId: collectiveId, enabled: true, type },
      order: [['order', 'asc']],
    });
  }
}

AccountingCategoryRule.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: { len: [3, 255] },
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    type: {
      type: DataTypes.ENUM('CONTRIBUTION'),
      allowNull: false,
    },
    order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    predicates: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: [],
      validate: {
        async isValidPredicates(value: unknown) {
          if (!Array.isArray(value)) {
            throw new Error('Predicates must be an array');
          }

          const normalizedPredicates = await Promise.all(
            value.map(predicate =>
              validateAndNormalizeContributionAccountingCategoryRulePredicate(
                predicate as ContributionAccountingCategoryRulePredicate,
              ),
            ),
          );

          (this as AccountingCategoryRule).setDataValue('predicates', normalizedPredicates);
        },
      },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
    AccountingCategoryId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'AccountingCategories' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'AccountingCategoryRules',
    paranoid: true,
  },
);
