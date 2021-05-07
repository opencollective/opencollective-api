import sequelize, { DataTypes } from '../lib/sequelize';

export const LEGAL_DOCUMENT_TYPE = {
  US_TAX_FORM: 'US_TAX_FORM',
};

function defineModel() {
  const NOT_REQUESTED = 'NOT_REQUESTED';
  const REQUESTED = 'REQUESTED';
  const RECEIVED = 'RECEIVED';
  const ERROR = 'ERROR';

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
        values: [NOT_REQUESTED, REQUESTED, RECEIVED, ERROR],
        allowNull: false,
        defaultValue: NOT_REQUESTED,
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
    return this.requestStatus === NOT_REQUESTED || this.requestStatus === ERROR;
  };

  LegalDocument.requestStatus = {
    REQUESTED,
    NOT_REQUESTED,
    RECEIVED,
    ERROR,
  };

  return LegalDocument;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const LegalDocument = defineModel();

export default LegalDocument;
