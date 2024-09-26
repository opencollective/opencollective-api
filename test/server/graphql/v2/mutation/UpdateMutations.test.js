import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { assert, createSandbox } from 'sinon';

import PlatformConstants from '../../../../../server/constants/platform';
import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import twitterLib from '../../../../../server/lib/twitter';
import models from '../../../../../server/models';
import { randStr } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

let host, user1, user2, collective1, event1, update1;
let sandbox, sendEmailSpy, sendTweetSpy;

describe('server/graphql/v2/mutation/UpdateMutations', () => {
  /* SETUP
     - collective1: host, user1 as admin
       - event1: user1 as admin
     - user2
  */

  before(() => {
    sandbox = createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    sendTweetSpy = sandbox.spy(twitterLib, 'tweetStatus');
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
    user2 = await models.User.createUserWithCollective(utils.data('user2'));
  });
  before(async () => {
    collective1 = await models.Collective.create(utils.data('collective1'));
  });
  before(() => collective1.addUserWithRole(host, roles.HOST));
  before(() => collective1.addUserWithRole(user1, roles.ADMIN));

  before(() => {
    return models.Update.create({
      CollectiveId: collective1.id,
      FromCollectiveId: user1.CollectiveId,
      CreatedByUserId: user1.id,
      notificationAudience: 'FINANCIAL_CONTRIBUTORS',
      title: 'first update & "love"',
      html: 'long text for the update #1 <a href="https://google.com">here is a link</a>',
    }).then(u => (update1 = u));
  });

  before('create an event collective', async () => {
    event1 = await models.Collective.create(
      Object.assign(utils.data('event1'), {
        CreatedByUserId: user1.id,
        ParentCollectiveId: collective1.id,
      }),
    );
  });
  before(() => event1.addUserWithRole(user1, roles.ADMIN));

  let update;
  before(() => {
    update = {
      title: 'Monthly update 2',
      html: 'This is the update',
      isChangelog: false,
      account: {
        legacyId: collective1.id,
      },
    };
  });

  describe('create an update', () => {
    const createUpdateMutation = gql`
      mutation CreateUpdate($update: UpdateCreateInput!) {
        createUpdate(update: $update) {
          id
          slug
          publishedAt
        }
      }
    `;

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(createUpdateMutation, { update });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('fails if authenticated but cannot edit collective', async () => {
      const result = await utils.graphqlQueryV2(createUpdateMutation, { update }, user2);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to create an update");
    });

    it('creates an update', async () => {
      const result = await utils.graphqlQueryV2(createUpdateMutation, { update }, user1);
      result.errors && console.error(result.errors[0]);
      const createdUpdate = result.data.createUpdate;
      expect(createdUpdate.slug).to.equal('monthly-update-2');
      expect(createdUpdate.publishedAt).to.be.null;
    });
  });

  describe('create a changelog update', () => {
    let user3, opencollective, changelogUpdate;
    before(async () => {
      sendEmailSpy.resetHistory();
      user3 = await models.User.createUserWithCollective(utils.data('user3'));
      opencollective = await models.Collective.create({
        name: 'Open Collective',
        slug: randStr('platform-'),
        id: PlatformConstants.PlatformCollectiveId,
      });
      opencollective.addUserWithRole(user3, roles.ADMIN);
      user3.update({ data: { isRoot: true } });
      changelogUpdate = {
        title: 'Monthly changelog update',
        html: 'New feature added',
        isChangelog: true,
        account: { legacyId: opencollective.id },
      };
    });
    const createUpdateMutation = gql`
      mutation CreateUpdate($update: UpdateCreateInput!) {
        createUpdate(update: $update) {
          id
          slug
          publishedAt
          isChangelog
        }
      }
    `;

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(createUpdateMutation, { update: changelogUpdate });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('fails if authenticated but cannot edit collective', async () => {
      const result = await utils.graphqlQueryV2(createUpdateMutation, { update: changelogUpdate }, user1);
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to create an update");
    });

    it('creates a changelog update', async () => {
      const result = await utils.graphqlQueryV2(createUpdateMutation, { update: changelogUpdate }, user3);
      result.errors && console.error(result.errors[0]);
      const createdUpdate = result.data.createUpdate;
      expect(createdUpdate.slug).to.equal('monthly-changelog-update');
      expect(createdUpdate.isChangelog).to.be.true;
      expect(createdUpdate.publishedAt).to.be.null;
    });

    it('do not send emails on changelog update', async () => {
      expect(sendEmailSpy.callCount).to.equal(0);
    });
  });

  describe('publish an update', () => {
    const publishUpdateMutation = gql`
      mutation PublishUpdate($id: String!, $notificationAudience: UpdateAudience) {
        publishUpdate(id: $id, notificationAudience: $notificationAudience) {
          id
          slug
          publishedAt
        }
      }
    `;

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(publishUpdateMutation, {
        id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE),
        notificationAudience: update1.notificationAudience,
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('fails if not authenticated as admin of collective', async () => {
      const result = await utils.graphqlQueryV2(
        publishUpdateMutation,
        { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), notificationAudience: update1.notificationAudience },
        user2,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to edit this update");
    });

    it('unpublishes an update successfully', async () => {
      sendEmailSpy.resetHistory();
      await models.Update.update({ publishedAt: new Date() }, { where: { id: update1.id } });
      const result = await utils.graphqlQueryV2(
        publishUpdateMutation.replace(/publish\(/g, 'unpublish('),
        { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), notificationAudience: update1.notificationAudience },
        user1,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.publishUpdate.slug).to.equal('first-update-and-love');
      expect(result.data.publishUpdate.publishedAt).to.not.be.null;
      await models.Update.update({ publishedAt: null }, { where: { id: update1.id } });
      await utils.waitForCondition(() => sendEmailSpy.callCount === 1, {
        tag: 'first update & "love"',
      });
    });

    describe('publishes an update', async () => {
      let result, noOneAudienceResult, update2, user4;

      before(async () => {
        sendEmailSpy.resetHistory();
        await collective1.addUserWithRole(user2, roles.BACKER);
        await utils.waitForCondition(() => sendEmailSpy.callCount === 1, {
          tag: "Anish Bas joined Scouts d'Arlon as backer",
        });
        sendEmailSpy.resetHistory();
        user4 = await models.User.createUserWithCollective(utils.data('user4'));
        const org = await models.Collective.create({
          name: 'facebook',
          type: 'ORGANIZATION',
        });
        org.addUserWithRole(user4, roles.ADMIN);
        await models.Member.create({
          CollectiveId: collective1.id,
          MemberCollectiveId: org.id,
          role: roles.BACKER,
          CreatedByUserId: user1.id,
        });
        await models.ConnectedAccount.create({
          CollectiveId: collective1.id,
          service: 'twitter',
          settings: { updatePublished: { active: true } },
        });
        result = await utils.graphqlQueryV2(
          publishUpdateMutation,
          { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), notificationAudience: update1.notificationAudience },
          user1,
        );
      });

      it('published the update successfully', async () => {
        expect(result.errors).to.not.exist;
        expect(result.data.publishUpdate.slug).to.equal('first-update-and-love');
        expect(result.data.publishUpdate.publishedAt).to.not.be.null;
      });

      it('sends the update to all users including admins of sponsor org', async () => {
        await utils.waitForCondition(() => sendEmailSpy.callCount === 3, {
          tag: 'first update & "love"',
        });
        expect(sendEmailSpy.callCount).to.equal(3);
        assert.calledWithMatch(sendEmailSpy, user1.email, 'first update & "love"');
        assert.calledWithMatch(sendEmailSpy, user2.email, 'first update & "love"');
        assert.calledWithMatch(sendEmailSpy, user4.email, 'first update & "love"');
      });

      it('sends a tweet', async () => {
        expect(sendTweetSpy.callCount).to.equal(1);
        expect(sendTweetSpy.firstCall.args[1]).to.equal('Latest update from the collective: first update & "love"');
        expect(sendTweetSpy.firstCall.args[2]).to.contain('/scouts/updates/first-update-and-love');
      });

      it('should publish update without notifying anyone', async () => {
        sendEmailSpy.resetHistory();

        update2 = await models.Update.create({
          CollectiveId: collective1.id,
          FromCollectiveId: user1.CollectiveId,
          CreatedByUserId: user1.id,
          notificationAudience: 'NO_ONE',
          title: 'second update',
          html: 'long text for the update #2 <a href="https://google.com">here is a link</a>',
        });

        noOneAudienceResult = await utils.graphqlQueryV2(
          publishUpdateMutation,
          { id: idEncode(update2.id, IDENTIFIER_TYPES.UPDATE), notificationAudience: update2.notificationAudience },
          user1,
        );

        expect(sendEmailSpy.callCount).to.equal(0);
        expect(noOneAudienceResult.data.publishUpdate.slug).to.equal('second-update');
        expect(noOneAudienceResult.data.publishUpdate.publishedAt).to.not.be.null;
      });
    });
  });

  describe('edit an update', () => {
    const editUpdateMutation = gql`
      mutation EditUpdate($update: UpdateUpdateInput!) {
        editUpdate(update: $update) {
          id
          slug
          publishedAt
        }
      }
    `;

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(editUpdateMutation, {
        update: { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE) },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
    });

    it('fails if not authenticated as admin of collective', async () => {
      const result = await utils.graphqlQueryV2(
        editUpdateMutation,
        { update: { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE) } },
        user2,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to edit this update");
    });

    it('edits an update successfully and changes the slug if not published', async () => {
      await models.Update.update({ publishedAt: null }, { where: { id: update1.id } });
      const result = await utils.graphqlQueryV2(
        editUpdateMutation,
        { update: { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), title: 'new title' } },
        user1,
      );
      expect(result.errors).to.not.exist;
      expect(result.data.editUpdate.slug).to.equal('new-title');
    });

    it('fails if user tries to update notificationAudience of a published update', async () => {
      await models.Update.update(
        { slug: 'first-update-and-love', publishedAt: new Date(), notificationAudience: 'FINANCIAL_CONTRIBUTORS' },
        { where: { id: update1.id } },
      );
      const result = await utils.graphqlQueryV2(
        editUpdateMutation,
        {
          update: {
            id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE),
            title: 'new title',
            notificationAudience: 'NO_ONE',
          },
        },
        user1,
      );

      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('Cannot change the notification audience of a published update');
    });

    it("edits an update successfully and doesn't change the slug if published", async () => {
      await models.Update.update(
        { slug: 'first-update-and-love', publishedAt: new Date() },
        { where: { id: update1.id } },
      );
      const result = await utils.graphqlQueryV2(
        editUpdateMutation,
        { update: { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), title: 'new title' } },
        user1,
      );
      result.errors && console.error(result.errors[0]);
      expect(result.errors).to.not.exist;
      expect(result.data.editUpdate.slug).to.equal('first-update-and-love');
      await models.Update.update({ publishedAt: null }, { where: { id: update1.id } });
    });

    it('fails if update title is not set', async () => {
      const result = await utils.graphqlQueryV2(
        editUpdateMutation,
        { update: { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), title: '' } },
        user1,
      );
      expect(result.errors[0].message).to.equal('Validation error: Validation len on title failed');
    });
  });
  describe('delete Update', () => {
    const deleteUpdateMutation = gql`
      mutation DeleteUpdate($id: String!) {
        deleteUpdate(id: $id) {
          id
          slug
        }
      }
    `;

    it('fails to delete an update if not logged in', async () => {
      const result = await utils.graphqlQueryV2(deleteUpdateMutation, {
        id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE),
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].extensions.code).to.equal('Unauthorized');
      return models.Update.findByPk(update1.id).then(updateFound => {
        expect(updateFound).to.not.be.null;
      });
    });

    it('fails to delete an update if logged in as another user', async () => {
      const result = await utils.graphqlQueryV2(
        deleteUpdateMutation,
        { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE) },
        user2,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to edit this update");
      return models.Update.findByPk(update1.id).then(updateFound => {
        expect(updateFound).to.not.be.null;
      });
    });

    it('deletes an update', async () => {
      const res = await utils.graphqlQueryV2(
        deleteUpdateMutation,
        { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE) },
        user1,
      );
      res.errors && console.error(res.errors[0]);
      expect(res.errors).to.not.exist;
      return models.Update.findByPk(update1.id).then(updateFound => {
        expect(updateFound).to.be.null;
      });
    });
  });
});
