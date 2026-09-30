import { expect } from 'chai';

// @ts-expect-error - migration uses module.exports interop
import migration from '../../migrations/20260930120000-remove-follower-members'; // eslint-disable-line import/default
import MemberRoles from '../../server/constants/roles';
import models, { sequelize } from '../../server/models';
import { fakeMember } from '../test-helpers/fake-data';
import { resetTestDB } from '../utils';

describe('migrations/20260930120000-remove-follower-members', () => {
  before(() => resetTestDB());

  it('permanently deletes active and soft-deleted followers and preserves other memberships', async () => {
    const activeFollower = await fakeMember({ role: MemberRoles.BACKER });
    const deletedFollower = await fakeMember({ role: MemberRoles.BACKER, deletedAt: new Date() });
    const otherMembers = await Promise.all(Object.values(MemberRoles).map(role => fakeMember({ role })));
    const deletedBacker = await fakeMember({ role: MemberRoles.BACKER, deletedAt: new Date() });
    const otherMembersBefore = await models.Member.findAll({
      where: { id: [...otherMembers.map(member => member.id), deletedBacker.id] },
      paranoid: false,
      order: [['id', 'ASC']],
      raw: true,
    });

    // Seed the retired role directly because the Member model no longer accepts it.
    await sequelize.query(`UPDATE "Members" SET role = 'FOLLOWER' WHERE id IN (:ids)`, {
      replacements: { ids: [activeFollower.id, deletedFollower.id] },
    });

    await migration.up(sequelize.getQueryInterface());

    expect(
      await models.Member.count({ where: { id: [activeFollower.id, deletedFollower.id] }, paranoid: false }),
    ).to.eq(0);
    expect(
      await models.Member.findAll({
        where: { id: [...otherMembers.map(member => member.id), deletedBacker.id] },
        paranoid: false,
        order: [['id', 'ASC']],
        raw: true,
      }),
    ).to.deep.eq(otherMembersBefore);

    await migration.up(sequelize.getQueryInterface());
    expect(await models.Member.count({ where: { role: 'FOLLOWER' }, paranoid: false })).to.eq(0);
  });
});
