import type { CreateOptions } from 'sequelize';

import roles from '../constants/roles';
import { Collective, Member, User } from '../models';

/** Shared by API-owned recipes and legacy test factories. Never swallows setup errors. */
export async function createAccountAdminMembers(
  account: Collective,
  admins: Array<User | { id: number; CreatedByUserId: number }>,
  options: CreateOptions = {},
) {
  return Promise.all(
    admins.map(admin => {
      const isUser = admin instanceof User;
      return Member.create(
        {
          CollectiveId: account.id,
          MemberCollectiveId: isUser ? admin.CollectiveId : admin.id,
          role: roles.ADMIN,
          CreatedByUserId: isUser ? admin.id : admin.CreatedByUserId,
        },
        options,
      );
    }),
  );
}
