import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import nock from 'nock';

import models from '../../../../../server/models';
import * as utils from '../../../../utils';

const requestAdminRemovalMutation = gqlV2`
  mutation requestAdminRemoval($collectiveId: Int!) {
    requestAdminRemoval(collectiveId: $collectiveId) {
      id
    }
  } 
`;

describe('server/graphql/v2/MemberMutation', () => {
  beforeEach('reset db', async () => {
    await utils.resetTestDB();
  });

  it('fails if not authenticated', async () => {
    const result = await utils.graphqlQueryV2(requestAdminRemovalMutation, {
      collectiveId: 1,
    });
    expect(result.errors).to.have.length(1);
    expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
  });

  // it('is a success', async () => {
  //   const user = await models.User.createUserWithCollective(utils.data('user2'));

  //   const result = await utils.graphqlQueryV2(requestAdminRemovalMutation, {
  //     collectiveId: user.id,
  //   });
  //   console.log(result,'===============')
  //   // expect(result.errors).to.have.length(1);
  //   // expect(result.errors[0].message).to.equal('You need to be authenticated to perform this action');
  // });
});
