import config from 'config';
import { pick } from 'lodash';
import { CreateOptions, InferAttributes, InferCreationAttributes, Model, Transaction } from 'sequelize';

import ActivityTypes from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import roles, { MemberRoleLabels } from '../constants/roles';
import { purgeCacheForCollective } from '../lib/cache';
import sequelize, { DataTypes } from '../lib/sequelize';

import Activity from './Activity';
import Collective from './Collective';
import Member from './Member';
import User from './User';

export const MEMBER_INVITATION_SUPPORTED_ROLES = [roles.ACCOUNTANT, roles.ADMIN, roles.MEMBER];

class MemberInvitation extends Model<InferAttributes<MemberInvitation>, InferCreationAttributes<MemberInvitation>> {
  declare id: number;
  declare CreatedByUserId: number;
  declare MemberCollectiveId: number;
  declare CollectiveId: number;
  declare TierId: number;
  declare role: roles.ACCOUNTANT | roles.ADMIN | roles.MEMBER;
  declare description: string;

  declare createdAt: Date;
  declare updatedAt: Date;
  declare deletedAt?: Date;
  declare since: Date | string;

  declare collective?: Collective;
  declare memberCollective?: Collective;

  declare sendEmail: (remoteUser: User, skipDefaultAdmin, sequelizeParams?: CreateOptions) => Promise<void>;

  declare invite: (
    collective,
    memberParams,
    { transaction, skipDefaultAdmin }?: { transaction?: Transaction; skipDefaultAdmin?: boolean },
  ) => Promise<MemberInvitation>;

  declare accept: () => Promise<MemberInvitation>;

  declare decline: () => Promise<void>;

  /**
   * Class Methods
   */
  static async invite(
    collective,
    memberParams,
    { transaction, skipDefaultAdmin }: { transaction?: Transaction; skipDefaultAdmin?: boolean } = {},
  ) {
    const sequelizeParams = transaction ? { transaction } : undefined;

    // Check params
    if (!MEMBER_INVITATION_SUPPORTED_ROLES.includes(memberParams.role)) {
      throw new Error(`Member invitation roles can only be one of: ${MEMBER_INVITATION_SUPPORTED_ROLES.join(', ')}`);
    } else if (collective.type === CollectiveType.USER) {
      throw new Error('Individual accounts do not support members');
    }

    // Ensure the user is not already a member
    const existingMember = await Member.findOne({
      where: {
        CollectiveId: collective.id,
        MemberCollectiveId: memberParams.MemberCollectiveId,
        role: memberParams.role,
      },
      ...sequelizeParams,
    });

    if (existingMember) {
      throw new Error(`This user already have the ${memberParams.role} role on this Collective`);
    }

    // Update the existing invitation if it exists
    let invitation = await MemberInvitation.findOne({
      include: [{ association: 'collective' }],
      where: {
        CollectiveId: collective.id,
        MemberCollectiveId: memberParams.MemberCollectiveId,
      },
      ...sequelizeParams,
    });

    if (invitation) {
      const updateData = pick(memberParams, ['role', 'description', 'since']);
      await invitation.update(updateData, sequelizeParams);
    } else {
      // Ensure collective has not invited too many people
      const memberCountWhere = { CollectiveId: collective.id, role: MEMBER_INVITATION_SUPPORTED_ROLES };
      const nbMembers = await Member.count({ where: memberCountWhere, ...sequelizeParams });
      const nbInvitations = await MemberInvitation.count({ where: memberCountWhere, ...sequelizeParams });
      if (nbMembers + nbInvitations > config.limits.maxCoreContributorsPerAccount) {
        throw new Error('You exceeded the maximum number of members for this account');
      }

      // Create new member invitation
      invitation = await MemberInvitation.create({ ...memberParams, CollectiveId: collective.id }, sequelizeParams);
      invitation.collective = collective;

      if (MEMBER_INVITATION_SUPPORTED_ROLES.includes(memberParams.role)) {
        const memberCollective = await Collective.findByPk(memberParams.MemberCollectiveId, sequelizeParams);
        await Activity.create(
          {
            type: ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITED,
            CollectiveId: collective.id,
            FromCollectiveId: memberParams.MemberCollectiveId,
            HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
            data: {
              notify: false,
              memberCollective: memberCollective.activity,
              collective: collective.activity,
              invitation: pick(invitation, ['id', 'role', 'description', 'since']),
            },
          },
          sequelizeParams,
        );
      }
    }

    // Load remote user
    // TODO: We should make `createdByUser` a required param
    const createdByUser = await User.findByPk(memberParams.CreatedByUserId, {
      include: [{ association: 'collective' }],
      ...sequelizeParams,
    });

    await invitation.sendEmail(createdByUser, skipDefaultAdmin, sequelizeParams);
    return invitation;
  }
}

MemberInvitation.init(
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
      onDelete: 'CASCADE',
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
          args: [MEMBER_INVITATION_SUPPORTED_ROLES],
          msg: 'Must be ACCOUNTANT, ADMIN or MEMBER',
        },
      },
    },

    description: {
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
    deletedAt: {
      type: DataTypes.DATE,
    },
    since: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    paranoid: true,
  },
);

// ---- Instance methods ----

MemberInvitation.prototype.accept = async function () {
  const existingMember = await Member.findOne({
    where: {
      MemberCollectiveId: this.MemberCollectiveId,
      CollectiveId: this.CollectiveId,
      TierId: this.TierId,
      role: this.role,
    },
  });

  // Ignore if membership already exists
  if (existingMember) {
    return this.destroy();
  }

  const user = await User.findOne({
    where: { CollectiveId: this.MemberCollectiveId },
    include: {
      model: Collective,
      as: 'collective',
      attributes: ['id'],
      where: { type: CollectiveType.USER, isIncognito: false },
    },
  });

  if (!user) {
    throw new Error(`No profile found for this user. Please contact support`);
  }

  const collective = await Collective.findByPk(this.CollectiveId);
  if (!collective) {
    throw new Error(`No collective found for this invitation. Please contact support`);
  }

  const member = await collective.addUserWithRole(user, this.role, {
    TierId: this.TierId,
    CreatedByUserId: this.CreatedByUserId,
    description: this.description,
    since: this.since,
  });
  purgeCacheForCollective(collective.slug);

  if (MEMBER_INVITATION_SUPPORTED_ROLES.includes(this.role)) {
    const memberCollective = await Collective.findByPk(this.MemberCollectiveId);
    await Activity.create({
      type: ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
      CollectiveId: this.CollectiveId,
      FromCollectiveId: this.MemberCollectiveId,
      HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
      data: {
        notify: false,
        memberCollective: memberCollective.activity,
        collective: collective.activity,
        member: member.info,
      },
    });
  }

  return this.destroy();
};

MemberInvitation.prototype.decline = async function () {
  await this.destroy();
  const collective = this.collective || (await this.getCollective());
  const memberCollective = this.memberCollective || (await this.getMemberCollective());
  await Activity.create({
    type: ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED,
    CollectiveId: this.CollectiveId,
    FromCollectiveId: this.MemberCollectiveId,
    HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
    data: {
      notify: false,
      memberCollective: memberCollective.activity,
      collective: collective.activity,
      invitation: pick(this, ['id', 'role', 'description', 'since']),
    },
  });
};

MemberInvitation.prototype.sendEmail = async function (remoteUser, skipDefaultAdmin = false, sequelizeParams = null) {
  // Load invitee
  const invitedUser = await User.findOne({
    where: { CollectiveId: this.MemberCollectiveId },
    include: [{ model: Collective, as: 'collective' }],
    ...sequelizeParams,
  });

  if (!invitedUser) {
    throw new Error('Cannot find invited user');
  }

  // Load collective
  const collective = this.collective || (await this.getCollective(sequelizeParams));

  // Send member invitation
  await Activity.create(
    {
      type: ActivityTypes.COLLECTIVE_MEMBER_INVITED,
      CollectiveId: collective.id,
      FromCollectiveId: this.MemberCollectiveId,
      HostCollectiveId: collective.approvedAt ? collective.HostCollectiveId : null,
      data: {
        role: MemberRoleLabels[this.role] || this.role.toLowerCase(),
        invitation: pick(this, ['id', 'role', 'description', 'since']),
        collective: pick(collective, ['id', 'slug', 'name']),
        memberCollective: pick(invitedUser.collective, ['id', 'slug', 'name']),
        invitedByUser: pick(remoteUser, ['collective.id', 'collective.slug', 'collective.name']),
        skipDefaultAdmin: skipDefaultAdmin,
      },
    },
    sequelizeParams,
  );
};

export default MemberInvitation;
