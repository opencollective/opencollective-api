import { expect } from 'chai';

import MemberRoles from '../../../server/constants/roles';
import { Member } from '../../../server/models';
import { fakeCollective, fakeMember, fakeUser } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/models/Member', () => {
  before(async () => {
    await resetTestDB();
  });

  it('rejects creating a follower membership', async () => {
    const account = await fakeCollective();
    const user = await fakeUser();

    await expect(
      Member.create({
        CollectiveId: account.id,
        MemberCollectiveId: user.CollectiveId,
        role: 'FOLLOWER' as MemberRoles,
      }),
    ).to.be.rejectedWith('Must be one of');

    expect(await Member.count({ where: { CollectiveId: account.id, MemberCollectiveId: user.CollectiveId } })).to.eq(0);
  });

  it('rejects changing a membership to the follower role', async () => {
    const member = await fakeMember({ role: MemberRoles.BACKER });

    await expect(member.update({ role: 'FOLLOWER' as MemberRoles })).to.be.rejectedWith('Must be one of');

    await member.reload();
    expect(member.role).to.eq(MemberRoles.BACKER);
  });
});
