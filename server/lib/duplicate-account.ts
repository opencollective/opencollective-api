import { isEmpty, omit, omitBy, pick } from 'lodash';
import { InferCreationAttributes, Op, Transaction } from 'sequelize';
import { v4 as uuid } from 'uuid';

import { CollectiveType } from '../constants/collectives';
import { Collective, Location, Member, sequelize, Tier, User } from '../models';

export type DuplicateAccountDataType = {
  admins?: boolean;
  tiers?: boolean;
  projects?: boolean;
  events?: boolean;
};

/**
 * Returns a slug that is not already taken
 */
const getNewAccountSlug = async (originalAccount: Collective, userProvidedSlug: string): Promise<string> => {
  if (originalAccount.type === CollectiveType.EVENT && originalAccount.slug.match(/-[0-9a-zA-Z]+$/)) {
    // Events normally have a random string at the end. We replace it by another random string
    const baseSlug = userProvidedSlug || originalAccount.slug.replace(/-[0-9a-zA-Z]+$/, '');
    return `${baseSlug}-${uuid().substr(0, 8)}`;
  } else {
    return Collective.generateSlug([userProvidedSlug || originalAccount.slug]);
  }
};

/**
 * Duplicate the collective core data and its location
 */
const duplicateCollectiveProfile = async (
  account: Collective,
  user: User,
  transaction: Transaction,
  values: Partial<InferCreationAttributes<Collective>> = {},
  oldProfileValues: Partial<InferCreationAttributes<Collective>> = {},
) => {
  const hostAndParentFields = ['ParentCollectiveId', 'HostCollectiveId', 'isActive', 'approvedAt'];
  let newAccount;
  try {
    newAccount = await Collective.create(
      {
        ...omit(account.dataValues, ['id', 'slug', 'createdAt', 'updatedAt', ...hostAndParentFields]),
        // For projects and events, we can safely copy the fields related to hosting. Other account types would need to be approved by the host.
        ...([CollectiveType.PROJECT, CollectiveType.EVENT].includes(account.type)
          ? pick(account.dataValues, hostAndParentFields)
          : []),
        ...values,
        CreatedByUserId: user.id || account.CreatedByUserId,
        LastEditedByUserId: user.id || account.LastEditedByUserId,
        slug: values.slug || (await getNewAccountSlug(account, values.slug)),
        name: values.name || account.name,
        data: {
          ...account.data,
          ...values.data,
          duplicatedFromCollectiveId: account.id,
        },
      },
      {
        transaction,
      },
    );
  } catch (e) {
    if (e.name === 'SequelizeUniqueConstraintError') {
      throw new Error('This slug is already taken');
    } else {
      throw e;
    }
  }

  // Duplicate location
  const location = await Location.findAll({ where: { CollectiveId: account.id }, transaction });
  if (location.length > 0) {
    await Location.bulkCreate(
      location.map(loc => ({
        ...omit(loc.dataValues, ['createdAt', 'updatedAt', 'id', 'CollectiveId']),
        CollectiveId: newAccount.id,
      })),
      { transaction },
    );
  }

  // Record a link to the new profile in the original profile
  const duplicatedToCollectiveIds = (account.data?.duplicatedToCollectiveIds as number[]) || [];
  await account.update(
    {
      ...oldProfileValues,
      data: {
        ...account.data,
        ...oldProfileValues?.data,
        duplicatedToCollectiveIds: [newAccount.id, ...duplicatedToCollectiveIds],
      },
    },
    { transaction },
  );

  return newAccount;
};

export const duplicateAccount = async (
  account: Collective,
  user: User,
  options: {
    /** The new slug. Defaults to an auto-generate one (from account name) */
    newSlug?: string;
    /** The new name. Defaults to the same as the original account */
    newName?: string;
    /** If the account has a new parent, set it here */
    newParent?: Collective;
    /** An optional name to update the old account with */
    oldName?: string;
    /** What data should be carried over */
    include?: DuplicateAccountDataType;
    /** Whether to connect both accounts */
    connect?: boolean;
    /** Optional transaction to use. Will create a new one if not provided */
    transaction?: Transaction;
  } = {},
): Promise<Collective> => {
  const duplicateAccountInTransaction = async transaction => {
    const oldProfileAttributes = omitBy({ name: options.oldName }, isEmpty);
    const newProfileAttributes = {
      slug: options.newSlug,
      name: options.newName,
      ...(!options.newParent
        ? {}
        : {
            ParentCollectiveId: options.newParent.id,
            HostCollectiveId: options.newParent.HostCollectiveId,
            isActive: options.newParent.isActive,
            approvedAt: options.newParent.approvedAt,
          }),
    };

    const newAccount = await duplicateCollectiveProfile(
      account,
      user,
      transaction,
      newProfileAttributes,
      oldProfileAttributes,
    );

    // ---- Associations ----
    // Admins
    if (options.include?.admins) {
      const admins = await account.getAdminUsers({ transaction });
      await Promise.all(admins.map(admin => newAccount.addUserWithRole(admin, 'ADMIN', null, null, transaction)));
    } else if (user) {
      await newAccount.addUserWithRole(user, 'ADMIN', null, null, transaction);
    }

    // Duplicate tiers
    if (options.include?.tiers) {
      const tiers = await account.getTiers({ transaction });
      await Tier.bulkCreate(
        tiers.map(tier => ({
          ...omit(tier.dataValues, ['createdAt', 'updatedAt', 'id', 'CollectiveId']),
          CollectiveId: newAccount.id,
        })),
        { transaction },
      );
    }

    // Duplicate projects
    if (options.include?.projects) {
      const projects = await account.getProjects({ transaction, where: { isActive: true } });
      await Promise.all(
        projects.map(project =>
          duplicateAccount(project, user, {
            transaction,
            newParent: newAccount,
            include: { tiers: true },
          }),
        ),
      );
    }

    // Duplicate Events
    if (options.include?.events) {
      const events = await account.getEvents({
        transaction,
        where: { isActive: true, endsAt: { [Op.or]: [{ [Op.eq]: null }, { [Op.gt]: new Date() }] } },
      });
      await Promise.all(
        events.map(project =>
          duplicateAccount(project, user, {
            transaction,
            newParent: newAccount,
            include: { tiers: true },
          }),
        ),
      );
    }

    // Link accounts
    if (options.connect) {
      const memberInfo = { since: new Date() };
      await Member.connectCollectives(account, newAccount, user, memberInfo, { transaction });
    }

    return newAccount;
  };

  if (options?.transaction) {
    return duplicateAccountInTransaction(options.transaction);
  } else {
    return sequelize.transaction(duplicateAccountInTransaction);
  }
};
