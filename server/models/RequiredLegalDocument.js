import sequelize, { DataTypes } from '../lib/sequelize';

function defineModel() {
  const US_TAX_FORM = 'US_TAX_FORM';

  const RequiredLegalDocument = sequelize.define('RequiredLegalDocument', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    documentType: {
      type: DataTypes.ENUM,
      values: [US_TAX_FORM],
      allowNull: false,
      defaultValue: US_TAX_FORM,
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
  });

  RequiredLegalDocument.documentType = {};
  RequiredLegalDocument.documentType.US_TAX_FORM = US_TAX_FORM;

  return RequiredLegalDocument;
}

// We're using the defineModel method to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const RequiredLegalDocument = defineModel();

export default RequiredLegalDocument;
