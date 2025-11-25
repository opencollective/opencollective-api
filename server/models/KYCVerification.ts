import { DataTypes, ForeignKey, InferAttributes, Model } from 'sequelize';
import Temporal from 'sequelize-temporal';

import sequelize from '../lib/sequelize';

import Collective from './Collective';

export enum KYCProviderName {
  MANUAL = 'manual',
}

export enum KYCVerificationStatus {
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  FAILED = 'FAILED',
  REVOKED = 'REVOKED',
  EXPIRED = 'EXPIRED',
}

type KycProviderData = {
  [KYCProviderName.MANUAL]: {
    legalName: string;
    legalAddress: string;
    notes: string;
  };
};

type KYCData<Provider extends KYCProviderName = KYCProviderName> = {
  providerData: Provider extends keyof KycProviderData ? KycProviderData[Provider] : unknown;
};

export class KYCVerification<Provider extends KYCProviderName = KYCProviderName> extends Model<
  InferAttributes<KYCVerification>,
  KYCVerification
> {
  declare id: number;
  declare CollectiveId: ForeignKey<Collective['id']>;
  declare RequestedByCollectiveId: ForeignKey<Collective['id']>;

  declare provider: Provider;
  declare status: KYCVerificationStatus;
  declare data: KYCData<Provider>;

  declare verifiedAt?: Date;
  declare revokedAt?: Date;

  declare createdAt: Date;
  declare updatedAt: Date;
  declare deletedAt?: Date;
}

KYCVerification.init(
  {
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      autoIncrement: true,
      primaryKey: true,
    },
    CollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      allowNull: false,
    },
    RequestedByCollectiveId: {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      allowNull: false,
    },
    data: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: sequelize.literal(`'{}'`),
    },
    provider: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.TEXT,
      allowNull: false,
      defaultValue: KYCVerificationStatus.PENDING,
    },
    verifiedAt: {
      type: DataTypes.DATE,
    },
    revokedAt: {
      type: DataTypes.DATE,
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
    },
  },
  {
    sequelize,
    tableName: 'KYCVerifications',
    paranoid: true,
  },
);

Temporal(KYCVerification, sequelize);
