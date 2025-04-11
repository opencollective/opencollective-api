import { pick } from 'lodash';
import {
  CreationOptional,
  ForeignKey,
  InferAttributes,
  InferCreationAttributes,
  Model,
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

class Member extends Model<InferAttributes<Member, { omit: 'info' }>, InferCreationAttributes<Member>> {
  declare public readonly id: CreationOptional<number>;
  declare public CreatedByUserId: ForeignKey<User['id']>;
  declare public MemberCollectiveId: ForeignKey<Collective['id']>;
  declare public CollectiveId: ForeignKey<Collective['id']>;
  declare public TierId: ForeignKey<Tier['id']>;
  declare public role: roles;
  declare public description: string;
  declare public publicMessage: string;
  declare public since: Date;
  declare public createdAt: Date;
  declare public updatedAt: Date;
  declare public deletedAt?: Date;

  declare public tier?: Tier;
  declare public memberCollective?: Collective;
  declare public collective?: Collective;

  get info() {
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
  }

  /**
   * Returns false if member is part of a tier with an interval and last donation is out of interval
   */
  static isActive = function (member: Member & { lastDonation: Date }) {
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

  static connectCollectives = function (
    childCollective: Collective,
    parentCollective: Collective,
    user: User,
    memberInfo,
    options: { transaction?: SequelizeTransaction } = {},
  ) {
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
}

Member.init(
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
    sequelize,
    modelName: 'Member',
    paranoid: true,
    indexes: [
      {
        fields: ['MemberCollectiveId', 'CollectiveId', 'role'],
        name: 'MemberCollectiveId-CollectiveId-role',
      },
    ],
    hooks: {
      afterCreate: instance => invalidateContributorsCacheUsingInstance(instance),
      afterUpdate: instance => invalidateContributorsCacheUsingInstance(instance),
    },
  },
);

export default Member;
