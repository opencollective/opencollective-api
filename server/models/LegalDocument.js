import sequelize, { DataTypes } from '../lib/sequelize';

export const LEGAL_DOCUMENT_TYPE = {
  US_TAX_FORM: 'US_TAX_FORM',
};

export const LEGAL_DOCUMENT_REQUEST_STATUS = {
  NOT_REQUESTED: 'NOT_REQUESTED',
  REQUESTED: 'REQUESTED',
  RECEIVED: 'RECEIVED',
  ERROR: 'ERROR',
};

const LegalDocument = sequelize.define(
  'LegalDocument',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    year: {
      type: DataTypes.INTEGER,
      validate: {
        min: 2015,
        notNull: true,
      },
      allowNull: false,
      unique: 'yearTypeCollective',
    },
    documentType: {
      type: DataTypes.ENUM,
      values: [LEGAL_DOCUMENT_TYPE.US_TAX_FORM],
      allowNull: false,
      defaultValue: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
      unique: 'yearTypeCollective',
    },
    documentLink: {
      type: DataTypes.STRING,
    },
    requestStatus: {
      type: DataTypes.ENUM,
      values: Object.values(LEGAL_DOCUMENT_REQUEST_STATUS),
      allowNull: false,
      defaultValue: LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED,
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
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
      unique: 'yearTypeCollective',
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    paranoid: true,
  },
);

LegalDocument.findByTypeYearCollective = ({ documentType, year, collective }) => {
  return LegalDocument.findOne({
    where: {
      year,
      CollectiveId: collective.id,
      documentType,
    },
  });
};

LegalDocument.prototype.shouldBeRequested = function () {
  return (
    this.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED ||
    this.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.ERROR
  );
};

LegalDocument.requestStatus = LEGAL_DOCUMENT_REQUEST_STATUS;

export default LegalDocument;
