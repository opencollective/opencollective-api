import { expect } from 'chai';
import gqlV1 from 'fake-tag';
import { describe, it } from 'mocha';

import roles from '../../../../server/constants/roles';
import models from '../../../../server/models';
import { fakeCollective, fakeUser } from '../../../test-helpers/fake-data';
import * as utils from '../../../utils';

const editCoreContributorsMutation = gqlV1 /* GraphQL */ `
  mutation EditCoreContributors($collectiveId: Int!, $members: [MemberInputType!]!) {
    editCoreContributors(collectiveId: $collectiveId, members: $members) {
      id
    }
  }
`;

describe('server/graphql/v1/editCoreContributors', () => {
  before(utils.resetTestDB);

  it('cannot change the team of a frozen account', async () => {
    const admin = await fakeUser();
    const collective = await fakeCollective({ admin });
    await collective.freeze('Frozen for audit', false);
    const [adminMember] = await models.Member.findAll({ where: { CollectiveId: collective.id, role: roles.ADMIN } });
    const newAdmin = await fakeUser();

    const result = await utils.graphqlQuery(
      editCoreContributorsMutation,
      {
        collectiveId: collective.id,
        members: [
          { id: adminMember.id, role: roles.ADMIN, member: { id: admin.CollectiveId } },
          { role: roles.ADMIN, member: { id: newAdmin.CollectiveId } },
        ],
      },
      admin,
    );

    expect(result.errors).to.have.length(1);
    expect(result.errors[0].extensions.code).to.equal('TeamLocked');
    expect(await models.Member.count({ where: { CollectiveId: collective.id, role: roles.ADMIN } })).to.equal(1);
    expect(await models.MemberInvitation.count({ where: { CollectiveId: collective.id } })).to.equal(0);
  });
});
