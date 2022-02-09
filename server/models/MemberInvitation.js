import config from 'config';
import { pick } from 'lodash';

import { types } from '../constants/collectives';
import roles, { MemberRoleLabels } from '../constants/roles';
import { purgeCacheForCollective } from '../lib/cache';
import emailLib from '../lib/email';
import sequelize, { DataTypes } from '../lib/sequelize';

export const MEMBER_INVITATION_SUPPORTED_ROLES = [roles.ACCOUNTANT, roles.ADMIN, roles.MEMBER];

function defineModel() {
  const { models } = sequelize;

  const MemberInvitation = sequelize.define(
    'MemberInvitation',
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
      paranoid: true,
    },
  );

  // ---- Instance methods ----

  MemberInvitation.prototype.accept = async function () {
    const existingMember = await models.Member.findOne({
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

    const user = await models.User.findOne({
      where: { CollectiveId: this.MemberCollectiveId },
      include: {
        model: models.Collective,
        as: 'collective',
        attributes: ['id'],
        where: { type: types.USER, isIncognito: false },
      },
    });

    if (!user) {
      throw new Error(`No profile found for this user. Please contact support`);
    }

    const collective = await models.Collective.findByPk(this.CollectiveId);
    if (collective) {
      await collective.addUserWithRole(user, this.role, {
        TierId: this.TierId,
        CreatedByUserId: this.CreatedByUserId,
        description: this.description,
        since: this.since,
      });
      purgeCacheForCollective(collective.slug);
    }

    return this.destroy();
  };

  MemberInvitation.prototype.decline = async function () {
    return this.destroy();
  };

  // ---- Static methods ----

  MemberInvitation.invite = async function (collective, memberParams, transaction) {
    const sequelizeParams = transaction ? { transaction } : undefined;

    // Check params
    if (!MEMBER_INVITATION_SUPPORTED_ROLES.includes(memberParams.role)) {
      throw new Error(`Member invitation roles can only be one of: ${MEMBER_INVITATION_SUPPORTED_ROLES.join(', ')}`);
    } else if (collective.type === types.USER) {
      throw new Error('Individual accounts do not support members');
    }

    // Ensure the user is not already a member or invited as such
    const existingMember = await models.Member.findOne(
      {
        where: {
          CollectiveId: collective.id,
          MemberCollectiveId: memberParams.MemberCollectiveId,
          role: memberParams.role,
        },
      },
      sequelizeParams,
    );

    if (existingMember) {
      throw new Error(`This user already have the ${memberParams.role} role on this Collective`);
    }

    // Update the existing invitation if it exists
    const existingInvitation = await models.MemberInvitation.findOne(
      {
        where: {
          CollectiveId: collective.id,
          MemberCollectiveId: memberParams.MemberCollectiveId,
        },
      },
      sequelizeParams,
    );

    if (existingInvitation) {
      return existingInvitation.update(pick(memberParams, ['role', 'description', 'since']), sequelizeParams);
    }

    // Ensure collective has not invited too many people
    const memberCountWhere = { CollectiveId: collective.id, role: MEMBER_INVITATION_SUPPORTED_ROLES };
    const nbMembers = await models.Member.count({ where: memberCountWhere });
    const nbInvitations = await models.MemberInvitation.count({ where: memberCountWhere });
    if (nbMembers + nbInvitations > config.limits.maxCoreContributorsPerAccount) {
      throw new Error('You exceeded the maximum number of members for this account');
    }

    // Load users
    const memberUser = await models.User.findOne(
      {
        where: { CollectiveId: memberParams.MemberCollectiveId },
        include: [{ model: models.Collective, as: 'collective' }],
      },
      sequelizeParams,
    );

    if (!memberUser) {
      throw new Error('user not found');
    }

    const createdByUser = await models.User.findByPk(
      memberParams.CreatedByUserId,
      {
        include: [{ model: models.Collective, as: 'collective' }],
      },
      sequelizeParams,
    );

    console.log('MemberInvitation.create', memberParams, collective.id);

    const invitation = await MemberInvitation.create(
      {
        ...memberParams,
        CollectiveId: collective.id,
      },
      sequelizeParams,
    );

    await emailLib.send('member.invitation', memberUser.email, {
      role: MemberRoleLabels[memberParams.role] || memberParams.role.toLowerCase(),
      invitation: pick(invitation, 'id'),
      collective: pick(collective, ['slug', 'name']),
      memberCollective: pick(memberUser, ['collective.slug', 'collective.name']),
      invitedByUser: pick(createdByUser, ['collective.slug', 'collective.name']),
    });

    return invitation;
  };

  return MemberInvitation;
}

// We're using the defineModel function to keep the indentation and have a clearer git history.
// Please consider this if you plan to refactor.
const MemberInvitation = defineModel();

export default MemberInvitation;
