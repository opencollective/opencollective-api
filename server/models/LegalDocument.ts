import config from 'config';
import { get, uniq } from 'lodash';
import moment from 'moment';
import {
  BelongsToGetAssociationMixin,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute,
  Op,
} from 'sequelize';

import { activities } from '../constants';
import { CollectiveType } from '../constants/collectives';
import { US_TAX_FORM_VALIDITY_IN_YEARS } from '../constants/tax-form';
import { parseS3Url } from '../lib/awsS3';
import { crypto, secretbox } from '../lib/encryption';
import { notify } from '../lib/notifications/email';
import SQLQueries from '../lib/queries';
import sequelize from '../lib/sequelize';
import { getTaxFormsS3Bucket } from '../lib/tax-forms';

import Activity from './Activity';
import Collective from './Collective';
import User from './User';

export enum LEGAL_DOCUMENT_TYPE {
  US_TAX_FORM = 'US_TAX_FORM',
}

export enum LEGAL_DOCUMENT_REQUEST_STATUS {
  NOT_REQUESTED = 'NOT_REQUESTED',
  REQUESTED = 'REQUESTED',
  RECEIVED = 'RECEIVED',
  ERROR = 'ERROR',
  INVALID = 'INVALID',
}

export const US_TAX_FORM_TYPES = ['W9', 'W8_BEN', 'W8_BEN_E'] as const;
export type USTaxFormType = (typeof US_TAX_FORM_TYPES)[number];

export enum LEGAL_DOCUMENT_SERVICE {
  DROPBOX_FORMS = 'DROPBOX_FORMS',
  OPENCOLLECTIVE = 'OPENCOLLECTIVE',
}

const ENCRYPTION_KEY = get(config, 'taxForms.encryptionKey');

export type LegalDocumentAttributes = InferAttributes<LegalDocument>;

class LegalDocument extends Model<LegalDocumentAttributes, InferCreationAttributes<LegalDocument>> {
  public declare id: number;
  public declare year: number;
  public declare documentType: string;
  public declare documentLink: string;
  public declare requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS | `${LEGAL_DOCUMENT_REQUEST_STATUS}`;
  public declare service: LEGAL_DOCUMENT_SERVICE | `${LEGAL_DOCUMENT_SERVICE}`;

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

  static encrypt = (content: Buffer): Buffer => {
    return secretbox.encrypt(content, ENCRYPTION_KEY);
  };

  static decrypt = (content: Buffer): Buffer => {
    return secretbox.decryptRaw(content, ENCRYPTION_KEY);
  };

  static hash = (formValues: Record<string, unknown>): string => {
    return crypto.hash(JSON.stringify(formValues));
  };

  /**
   * Send a tax form request to the collective using the new internal system.
   */
  static createTaxFormRequestToCollectiveIfNone = async (
    payee: Collective,
    user: User,
    {
      UserTokenId,
      ExpenseId,
      HostCollectiveId,
    }: {
      UserTokenId?: number;
      ExpenseId?: number;
      HostCollectiveId?: number;
    } = {},
  ): Promise<LegalDocument> => {
    return sequelize.transaction(async transaction => {
      const [legalDocument, isNew] = await LegalDocument.findOrCreate({
        transaction,
        where: {
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          CollectiveId: payee.id,
          year: { [Op.gte]: new Date().getFullYear() - US_TAX_FORM_VALIDITY_IN_YEARS },
          requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
        },
        defaults: {
          CollectiveId: payee.id,
          documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
          year: new Date().getFullYear(),
          requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
          service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        },
      });

      if (isNew) {
        // This will not trigger any email directly, we'll only send it in `cron/hourly/40-send-tax-form-requests.js`
        await Activity.create(
          {
            type: activities.TAXFORM_REQUEST,
            UserId: user.id,
            CollectiveId: payee.id,
            HostCollectiveId: HostCollectiveId,
            UserTokenId,
            ExpenseId,
            data: {
              service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
              isSystem: true,
              legalDocument: legalDocument.info,
              collective: payee.activity,
              accountName: payee.name || payee.legalName || payee.slug,
            },
          },
          {
            transaction,
          },
        );
      }

      return legalDocument;
    });
  };

  /**
   * To use when a host admin manually provides an external link to a tax form.
   */
  static manuallyMarkTaxFormAsReceived = (
    payee: Collective,
    user: User,
    documentLink: string,
    {
      UserTokenId,
      year,
    }: {
      UserTokenId?: number;
      year?: number;
    } = {},
  ) => {
    return sequelize.transaction(async sqlTransaction => {
      let legalDocument = await LegalDocument.findOne({
        where: { CollectiveId: payee.id, requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED },
        lock: true,
        transaction: sqlTransaction,
      });

      const attributes = {
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.RECEIVED,
        documentLink,
        year: year || new Date().getFullYear(),
      };

      if (legalDocument) {
        await legalDocument.update(attributes, { transaction: sqlTransaction });
      } else {
        legalDocument = await LegalDocument.create(
          { ...attributes, CollectiveId: payee.id },
          { transaction: sqlTransaction },
        );
      }

      // This won't trigger any email
      await Activity.create({
        type: activities.TAXFORM_RECEIVED,
        UserId: user.id,
        CollectiveId: payee.id,
        FromCollectiveId: user.CollectiveId,
        UserTokenId: UserTokenId,
        data: {
          service: legalDocument.service,
          document: legalDocument.info,
          account: payee.info,
          isManual: true,
        },
      });
    });
  };

  static sendRemindersForTaxForms = async () => {
    // With the internal tax form system, we only send the email as a reminder in case they don't fill
    // their tax forms right away.
    const requestedLegalDocuments = await LegalDocument.findAll({
      where: {
        documentType: LEGAL_DOCUMENT_TYPE.US_TAX_FORM,
        requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
        service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        data: { reminderSentAt: null },
        createdAt: {
          [Op.lt]: moment().subtract(48, 'hours').toDate(),
          [Op.gt]: moment().subtract(7, 'days').toDate(),
        },
      },
      include: [
        {
          association: 'collective',
          required: true,
          where: { type: { [Op.not]: CollectiveType.VENDOR } },
        },
      ],
    });

    // Filter out all the legal docs where a tax form is not needed anymore (e.g. because the expense amount was updated)
    const allAccountIds = uniq(requestedLegalDocuments.map(d => d.CollectiveId));
    const accountIdsWithPendingTaxForm = await SQLQueries.getTaxFormsRequiredForAccounts({
      CollectiveId: allAccountIds,
      ignoreReceived: true,
    });
    const filteredDocuments = requestedLegalDocuments.filter(d => accountIdsWithPendingTaxForm.has(d.CollectiveId));
    for (const legalDocument of filteredDocuments) {
      const correspondingActivity = await Activity.findOne({
        where: {
          type: activities.TAXFORM_REQUEST,
          CollectiveId: legalDocument.CollectiveId,
          data: { service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE, legalDocument: { id: legalDocument.id } },
        },
      });

      if (correspondingActivity) {
        await notify.user(correspondingActivity);
        await legalDocument.update({ data: { ...legalDocument.data, reminderSentAt: new Date() } });
      }
    }
  };

  shouldBeRequested = function () {
    return (
      this.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.NOT_REQUESTED ||
      this.requestStatus === LEGAL_DOCUMENT_REQUEST_STATUS.ERROR
    );
  };

  isExpired = function () {
    if (this.documentType !== LEGAL_DOCUMENT_TYPE.US_TAX_FORM) {
      return false;
    } else {
      return new Date().getFullYear() > this.year + US_TAX_FORM_VALIDITY_IN_YEARS;
    }
  };

  /**
   * Returns true if the tax form is accessible by the host.
   */
  isAccessibleByHost = async function (host: Collective): Promise<boolean> {
    if (this.documentType !== LEGAL_DOCUMENT_TYPE.US_TAX_FORM) {
      return false;
    }

    const hostLegalDocumentsCount = await host.countRequiredLegalDocuments({
      where: { HostCollectiveId: host.id, documentType: this.documentType },
    });

    if (hostLegalDocumentsCount === 0) {
      return false;
    }

    const taxFormAccounts = await SQLQueries.getTaxFormsRequiredForAccounts({
      HostCollectiveId: host.id,
      CollectiveId: this.CollectiveId,
      year: this.year,
    });

    return taxFormAccounts.has(this.CollectiveId);
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
      return bucket === getTaxFormsS3Bucket();
    } catch (e) {
      return false;
    }
  };

  markAsInvalid = async (
    user: User,
    host: Collective,
    message: string,
    {
      UserTokenId,
    }: {
      UserTokenId?: number;
    } = {},
  ): Promise<void> => {
    // Preload associations
    this.collective = this.collective || (await this.getCollective());

    return sequelize.transaction(async transaction => {
      // Mark current tax form as invalid
      await this.update({ requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.INVALID }, { transaction });

      // Create a new tax form request
      await LegalDocument.create(
        {
          CollectiveId: this.CollectiveId,
          documentType: this.documentType,
          year: this.year,
          requestStatus: LEGAL_DOCUMENT_REQUEST_STATUS.REQUESTED,
          service: LEGAL_DOCUMENT_SERVICE.OPENCOLLECTIVE,
        },
        {
          transaction,
        },
      );

      // Create activity (sends the email)
      await Activity.create(
        {
          type: activities.TAXFORM_INVALIDATED,
          UserId: user.id,
          CollectiveId: this.CollectiveId,
          FromCollectiveId: user.CollectiveId,
          HostCollectiveId: host.id,
          UserTokenId,
          data: {
            document: this.info,
            collective: this.collective.info,
            host: host.info,
            message,
          },
        },
        { transaction },
      );

      return this;
    });
  };

  get info(): NonAttribute<Partial<LegalDocument>> {
    return {
      id: this.id,
      year: this.year,
      documentType: this.documentType,
      requestStatus: this.requestStatus,
      service: this.service,
      documentLink: this.documentLink,
    };
  }
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
