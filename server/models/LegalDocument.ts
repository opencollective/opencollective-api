import config from 'config';
import { get } from 'lodash';
import { BelongsToGetAssociationMixin, DataTypes, InferAttributes, InferCreationAttributes, Model } from 'sequelize';

import { crypto, secretbox } from '../lib/encryption';
import sequelize from '../lib/sequelize';

import Collective from './Collective';
import { parseS3Url } from '../lib/awsS3';

export const LEGAL_DOCUMENT_TYPE = {
  US_TAX_FORM: 'US_TAX_FORM',
};

export enum LEGAL_DOCUMENT_REQUEST_STATUS {
  NOT_REQUESTED = 'NOT_REQUESTED',
  REQUESTED = 'REQUESTED',
  RECEIVED = 'RECEIVED',
  ERROR = 'ERROR',
}

export enum LEGAL_DOCUMENT_SERVICE {
  DROPBOX_FORMS = 'DROPBOX_FORMS',
  OPENCOLLECTIVE = 'OPENCOLLECTIVE',
}

const ENCRYPTION_KEY = get(config, 'helloworks.documentEncryptionKey');

class LegalDocument extends Model<InferAttributes<LegalDocument>, InferCreationAttributes<LegalDocument>> {
  public declare id: number;
  public declare year: number;
  public declare documentType: string;
  public declare documentLink: string;
  public declare requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS | `${LEGAL_DOCUMENT_REQUEST_STATUS}`;
  public declare service: LEGAL_DOCUMENT_SERVICE | `${LEGAL_DOCUMENT_SERVICE}`;
  public declare encryptedFormData: string;

  public declare CollectiveId: number;
  public declare collective?: Collective;
  public declare getCollective: BelongsToGetAssociationMixin<Collective>;

  public declare createdAt: Date;
  public declare updatedAt: Date;
  public declare deletedAt?: Date;

  public declare data: any;

  static findByTypeYearCollective = ({ documentType, year, collective }) => {
    return LegalDocument.findOne({
      where: {
        year,
        CollectiveId: collective.id,
        documentType,
      },
    });
  };

  static createUSTaxFromFromData = async (
    year: number,
    collective: Collective,
    formData: Record<string, unknown>,
    existingRequest: LegalDocument = null,
  ) => {
    const encryptedFormData = crypto.encrypt(JSON.stringify(formData));
    if (existingRequest) {
      if (existingRequest.documentType !== LEGAL_DOCUMENT_TYPE.US_TAX_FORM) {
        throw new Error(`Incompatible document type ${existingRequest.documentType}`);
      } else if (existingRequest.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED) {
        throw new Error('A tax form has already been submitted for this account');
      }
      return existingRequest.update({
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        encryptedFormData,
      });
    } else {
      return LegalDocument.create({
        year,
        CollectiveId: collective.id,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        encryptedFormData,
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
      });
    }
  };

  static encryptFileContent = (content: Buffer): Buffer => {
    return secretbox.encrypt(content, ENCRYPTION_KEY);
  };

  static decryptFileContent = (content: Buffer): string => {
    return secretbox.decrypt(content, ENCRYPTION_KEY);
  };

  shouldBeRequested = function () {
    return (
      this.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED ||
      this.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.ERROR
    );
  };

  /**
   * Whether the document can be downloaded.
   *
   * Some links have been manually set to arbitrary values (e.g. Google Drive) by the support team in the past. Only "Official" S3 links can be downloaded.
   */
  canDownload = function (): boolean {
    if (!this.documentLink) {
      return false;
    }

    try {
      const { bucket } = parseS3Url(this.documentLink);
      return bucket === config.helloworks.aws.s3.bucket;
    } catch (e) {
      return false;
    }
  };
}

LegalDocument.init(
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
    service: {
      type: DataTypes.ENUM(...Object.values(LEGAL_DOCUMENT_SERVICE)),
      allowNull: false,
      defaultValue: LEGAL_DOCUMENT_SERVICE.DROPBOX_FORMS,
    },
    encryptedFormData: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
  },
  {
    sequelize,
    paranoid: true,
  },
);

export default LegalDocument;
