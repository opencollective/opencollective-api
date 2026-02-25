import { CreationOptional, InferAttributes } from 'sequelize';

import sequelize, { DataTypes } from '../lib/sequelize';

import { LEGAL_DOCUMENT_TYPE } from './LegalDocument';
import { ModelWithPublicId } from './ModelWithPublicId';

class RequiredLegalDocument extends ModelWithPublicId<
  InferAttributes<RequiredLegalDocument>,
  InferAttributes<RequiredLegalDocument>
> {
  public static readonly nanoIdPrefix = 'reqdoc' as const;
  public static readonly tableName = 'RequiredLegalDocuments' as const;

  declare public readonly id: CreationOptional<number>;
  declare public readonly publicId: string;
  declare public documentType: LEGAL_DOCUMENT_TYPE;
  declare public HostCollectiveId: number;

  declare public createdAt: CreationOptional<Date>;
  declare public updatedAt: CreationOptional<Date>;
  declare public deletedAt: CreationOptional<Date>;
}

RequiredLegalDocument.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    publicId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: false,
    },
    documentType: {
      type: DataTypes.ENUM,
      values: ['US_TAX_FORM'],
      allowNull: false,
      defaultValue: 'US_TAX_FORM',
    },
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    deletedAt: {
      type: DataTypes.DATE,
    },
    HostCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
    },
  },
  {
    sequelize,
    paranoid: true,
  },
);

export default RequiredLegalDocument;
