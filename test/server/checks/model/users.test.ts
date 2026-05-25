import { expect } from 'chai';
import { QueryTypes } from 'sequelize';

import { checkAtMostOneIncognitoProfilePerUser } from '../../../../checks/model/users';
import { sequelize } from '../../../../server/models';
import { fakeIncognitoProfile, fakeUser } from '../../../test-helpers/fake-data';
import { resetTestDB } from '../../../utils';

describe('checks/model/users: checkAtMostOneIncognitoProfilePerUser', () => {
  beforeEach(async () => {
    await resetTestDB();
  });

  async function countIncognitoProfilesForUserCollective(collectiveId: number): Promise<number> {
    const rows = await sequelize.query<{ count: string }>(
      `
       SELECT COUNT(DISTINCT ic."id")::text AS count
       FROM "Members" m
       INNER JOIN "Collectives" ic ON ic."id" = m."CollectiveId"
         AND ic."deletedAt" IS NULL
         AND ic."type" = 'USER'
         AND ic."isIncognito" IS TRUE
       WHERE m."MemberCollectiveId" = :collectiveId
         AND m."role" = 'ADMIN'
         AND m."deletedAt" IS NULL
      `,
      {
        replacements: { collectiveId },
        type: QueryTypes.SELECT,
        raw: true,
      },
    );
    return parseInt(rows[0].count, 10);
  }

  it('does not throw when the user has at most one incognito profile', async () => {
    const user = await fakeUser();
    await fakeIncognitoProfile(user);

    await expect(checkAtMostOneIncognitoProfilePerUser({ fix: false })).to.be.fulfilled;
  });

  it('does not throw when the user has no incognito profile', async () => {
    await fakeUser();

    await expect(checkAtMostOneIncognitoProfilePerUser({ fix: false })).to.be.fulfilled;
  });

  it('throws when the user has more than one incognito profile', async () => {
    const user = await fakeUser();
    await fakeIncognitoProfile(user);
    await fakeIncognitoProfile(user);

    expect(await countIncognitoProfilesForUserCollective(user.CollectiveId)).to.eq(2);

    await expect(checkAtMostOneIncognitoProfilePerUser({ fix: false })).to.be.rejectedWith(
      /more than one incognito profile/,
    );
  });

  it('merges duplicate incognito profiles when fix is enabled', async () => {
    const user = await fakeUser();
    await fakeIncognitoProfile(user);
    await fakeIncognitoProfile(user);

    expect(await countIncognitoProfilesForUserCollective(user.CollectiveId)).to.eq(2);

    await checkAtMostOneIncognitoProfilePerUser({ fix: true });

    expect(await countIncognitoProfilesForUserCollective(user.CollectiveId)).to.eq(1);

    await expect(checkAtMostOneIncognitoProfilePerUser({ fix: false })).to.be.fulfilled;
  });
});
