import { pick } from 'lodash';
import {
  InferAttributes,
  InferCreationAttributes,
  Model,
  ModelStatic,
  Transaction as SequelizeTransaction,
} from 'sequelize';

import { CollectiveType } from '../constants/collectives';
import roles from '../constants/roles';
import { invalidateContributorsCache } from '../lib/contributors';
import sequelize, { DataTypes } from '../lib/sequelize';
import { days } from '../lib/utils';

import Collective from './Collective';
import Tier from './Tier';
import User from './User';

const invalidateContributorsCacheUsingInstance = instance => {
  if (instance.role !== roles.FOLLOWER) {
    invalidateContributorsCache(instance.CollectiveId);
  }
  return null;
};

interface MemberModelStaticInterface {
  isActive(member: { tier?: Tier; lastDonation?: Date }): boolean;
  connectCollectives(
    childCollective: Collective,
    parentCollective: Collective,
    user: User,
    memberInfo: any,
    options?: { transaction?: SequelizeTransaction },
  ): Promise<MemberModelInterface>;
}

export interface MemberModelInterface
  extends Model<InferAttributes<MemberModelInterface>, InferCreationAttributes<MemberModelInterface>> {
  id: number;
  CreatedByUserId: number;
  MemberCollectiveId: number;
  CollectiveId: number;
  TierId: number;
  role: roles;
  description: string;
  publicMessage: string;

  since: Date;

  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date;

  tier?: Tier;
  memberCollective?: Collective;
  collective?: Collective;

  info(): Pick<
    MemberModelInterface,
    | 'role'
    | 'description'
    | 'publicMessage'
    | 'CreatedByUserId'
    | 'CollectiveId'
    | 'MemberCollectiveId'
    | 'createdAt'
    | 'updatedAt'
    | 'deletedAt'
    | 'since'
  >;
}

const Member: ModelStatic<MemberModelInterface> & MemberModelStaticInterface = sequelize.define(
  'Member',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },

    CreatedByUserId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Users',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    MemberCollectiveId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Collectives',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: false,
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
    },

    TierId: {
      type: DataTypes.INTEGER,
      references: {
        model: 'Tiers',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
    },

    role: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'member',
      validate: {
        isIn: {
          args: [Object.values(roles)],
          msg: `Must be one of ${Object.values(roles)}`,
        },
      },
    },

    description: DataTypes.STRING,

    publicMessage: {
      type: DataTypes.STRING,
    },

    // Dates.
    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
    since: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    paranoid: true,
    indexes: [
      {
        fields: ['MemberCollectiveId', 'CollectiveId', 'role'],
        name: 'MemberCollectiveId-CollectiveId-role',
      },
    ],
    getterMethods: {
      // Info.
      info() {
        return {
          role: this.role,
          description: this.description,
          publicMessage: this.publicMessage,
          CreatedByUserId: this.CreatedByUserId,
          CollectiveId: this.CollectiveId,
          MemberCollectiveId: this.MemberCollectiveId,
          createdAt: this.createdAt,
          updatedAt: this.updatedAt,
          deletedAt: this.deletedAt,
          since: this.since,
        };
      },
    },
    hooks: {
      afterCreate: instance => invalidateContributorsCacheUsingInstance(instance),
      afterUpdate: instance => invalidateContributorsCacheUsingInstance(instance),
    },
  },
);

/**
 * Returns false if member is part of a tier with an interval and last donation is out of interval
 * @param {*} member { tier: { interval }, lastDonation}
 */
Member.isActive = member => {
  if (!member.tier || !member.tier.interval) {
    return true;
  }
  if (!member.lastDonation) {
    return false;
  }
  if (member.tier.interval === 'month' && days(new Date(member.lastDonation)) <= 31) {
    return true;
  }
  if (['year', 'flexible'].includes(member.tier.interval) && days(new Date(member.lastDonation)) <= 365) {
    return true;
  }

  return false;
};

Member.connectCollectives = (childCollective, parentCollective, user, memberInfo, options = {}) => {
  const CONNECTED_ACCOUNT_ACCEPTED_TYPES = [
    CollectiveType.COLLECTIVE,
    CollectiveType.EVENT,
    CollectiveType.ORGANIZATION,
    CollectiveType.PROJECT,
    CollectiveType.FUND,
  ];

  if (childCollective.id === parentCollective.id) {
    throw new Error('Cannot connect an account to itself');
  } else if (
    !CONNECTED_ACCOUNT_ACCEPTED_TYPES.includes(childCollective.type) ||
    !CONNECTED_ACCOUNT_ACCEPTED_TYPES.includes(parentCollective.type)
  ) {
    throw new Error('Account type not supported for connected accounts');
  }

  const uniqueMemberAttributes = {
    role: roles.CONNECTED_COLLECTIVE,
    MemberCollectiveId: childCollective.id,
    CollectiveId: parentCollective.id,
  };

  const createMembership = async transaction => {
    const existingMember = await Member.findOne({ where: uniqueMemberAttributes, transaction });
    if (existingMember) {
      return existingMember;
    } else {
      return Member.create(
        {
          ...pick(memberInfo, ['description', 'since']),
          ...uniqueMemberAttributes,
          CreatedByUserId: user.id,
        },
        { transaction },
      );
    }
  };

  if (options?.transaction) {
    return createMembership(options.transaction);
  } else {
    return sequelize.transaction(createMembership);
  }
};

export default Member;
