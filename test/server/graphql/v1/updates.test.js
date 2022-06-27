import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { createSandbox } from 'sinon';

import roles from '../../../../server/constants/roles';
import models from '../../../../server/models';
import * as utils from '../../../utils';

let host, user1, collective1, event1;
let sandbox;

describe('server/graphql/v1/updates', () => {
  /* SETUP
     - collective1: host, user1 as admin
       - event1: user1 as admin
  */

  before(() => {
    sandbox = createSandbox();
  });

  after(() => sandbox.restore());

  before(() => utils.resetTestDB());

  before(async () => {
    user1 = await models.User.createUserWithCollective(utils.data('user1'));
  });

  before(async () => {
    host = await models.User.createUserWithCollective(utils.data('host1'));
  });

  before(async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });
  before(() => collective1.addUserWithRole(host, roles.HOST));
  before(() => collective1.addUserWithRole(user1, roles.ADMIN));

  before('create an event collective', async () => {
    event1 = await models.Collective.create(
      Object.assign(utils.data('event1'), {
        CreatedByUserId: user1.id,
        ParentCollectiveId: collective1.id,
      }),
    );
  });
  before(() => event1.addUserWithRole(user1, roles.ADMIN));

  describe('query updates', () => {
    const allUpdatesQuery = gql`
      query AllUpdates($CollectiveId: Int!, $limit: Int, $offset: Int) {
        allUpdates(CollectiveId: $CollectiveId, limit: $limit, offset: $offset) {
          id
          slug
          title
          publishedAt
        }
      }
    `;

    before(() => {
      return models.Update.destroy({ where: {}, truncate: true }).then(() =>
        models.Update.createMany(
          [
            {
              title: 'draft update 1',
              createdAt: new Date('2018-01-11'),
              publishedAt: null,
            },
            { title: 'update 1', publishedAt: new Date('2018-01-01') },
            { title: 'update 2', publishedAt: new Date('2018-01-02') },
            { title: 'update 3', publishedAt: new Date('2018-01-03') },
            { title: 'update 4', publishedAt: new Date('2018-01-04') },
            { title: 'update 5', publishedAt: new Date('2018-01-05') },
            { title: 'update 6', publishedAt: new Date('2018-01-06') },
            { title: 'update 7', publishedAt: new Date('2018-01-07') },
            { title: 'update 8', publishedAt: new Date('2018-01-08') },
            { title: 'update 9', publishedAt: new Date('2018-01-09') },
            { title: 'update 10', publishedAt: new Date('2018-01-10') },
          ],
          { CreatedByUserId: user1.id, CollectiveId: collective1.id },
        ),
      );
    });

    it('get all the updates that are published', async () => {
      const result = await utils.graphqlQuery(allUpdatesQuery, {
        CollectiveId: collective1.id,
        limit: 5,
        offset: 2,
      });
      const updates = result.data.allUpdates;
      expect(result.errors).to.not.exist;
      expect(updates).to.have.length(5);
      expect(updates[0].slug).to.equal('update-8');
    });

    it('get all the updates that are published and unpublished if admin', async () => {
      const result = await utils.graphqlQuery(
        allUpdatesQuery,
        { CollectiveId: collective1.id, limit: 5, offset: 0 },
        user1,
      );
      const updates = result.data.allUpdates;
      expect(result.errors).to.not.exist;
      expect(updates).to.have.length(5);
      expect(updates[0].slug).to.equal('draft-update-1');
    });
  });
});
