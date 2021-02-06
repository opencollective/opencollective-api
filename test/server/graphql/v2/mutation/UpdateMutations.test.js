import { expect } from 'chai';
import gqlV2 from 'fake-tag';
import { describe, it } from 'mocha';
import sinon from 'sinon';

import roles from '../../../../../server/constants/roles';
import { idEncode, IDENTIFIER_TYPES } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import twitterLib from '../../../../../server/lib/twitter';
import models from '../../../../../server/models';
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
    sandbox = sinon.createSandbox();
    sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    sendTweetSpy = sandbox.spy(twitterLib, 'tweetStatus');
  });

  after(() => sandbox.restore());

  before(() => utils.resetTestDB());

  before(() => models.User.createUserWithCollective(utils.data('user1')).tap(u => (user1 = u)));
  before(() => models.User.createUserWithCollective(utils.data('host1')).tap(u => (host = u)));

  before(() => models.User.createUserWithCollective(utils.data('user2')).tap(u => (user2 = u)));
  before(() => models.Collective.create(utils.data('collective1')).tap(g => (collective1 = g)));
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

  before('create an event collective', () =>
    models.Collective.create(
      Object.assign(utils.data('event1'), {
        CreatedByUserId: user1.id,
        ParentCollectiveId: collective1.id,
      }),
    ).tap(e => (event1 = e)),
  );
  before(() => event1.addUserWithRole(user1, roles.ADMIN));

  let update;
  before(() => {
    update = {
      title: 'Monthly update 2',
      html: 'This is the update',
      account: {
        legacyId: collective1.id,
      },
    };
  });

  describe('create an update', () => {
    const createUpdateMutation = gqlV2/* GraphQL */ `
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
      expect(result.errors[0].message).to.equal('You must be logged in to create an update');
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

  describe('publish an update', () => {
    const publishUpdateMutation = gqlV2/* GraphQL */ `
      mutation PublishUpdate($id: String!, $notificationAudience: UpdateAudienceType!) {
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
      expect(result.errors[0].message).to.equal('You must be logged in to publish this update');
    });

    it('fails if not authenticated as admin of collective', async () => {
      const result = await utils.graphqlQueryV2(
        publishUpdateMutation,
        { id: idEncode(update1.id, IDENTIFIER_TYPES.UPDATE), notificationAudience: update1.notificationAudience },
        user2,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to publish this update");
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
      let result, user3;

      before(async () => {
        sendEmailSpy.resetHistory();
        await collective1.addUserWithRole(user2, roles.BACKER);
        await utils.waitForCondition(() => sendEmailSpy.callCount === 1, {
          tag: "Anish Bas joined Scouts d'Arlon as backer",
        });
        sendEmailSpy.resetHistory();
        user3 = await models.User.createUserWithCollective(utils.data('user3'));
        const org = await models.Collective.create({
          name: 'facebook',
          type: 'ORGANIZATION',
        });
        org.addUserWithRole(user3, roles.ADMIN);
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
        expect(sendEmailSpy.args[0][0]).to.equal(user1.email);
        expect(sendEmailSpy.args[0][1]).to.equal('first update & "love"');
        expect(sendEmailSpy.args[1][0]).to.equal(user2.email);
        expect(sendEmailSpy.args[1][1]).to.equal('first update & "love"');
        expect(sendEmailSpy.args[2][0]).to.equal(user3.email);
        expect(sendEmailSpy.args[2][1]).to.equal('first update & "love"');
      });

      it('sends a tweet', async () => {
        expect(sendTweetSpy.callCount).to.equal(1);
        expect(sendTweetSpy.firstCall.args[1]).to.equal('Latest update from the collective: first update & "love"');
        expect(sendTweetSpy.firstCall.args[2]).to.contain('/scouts/updates/first-update-and-love');
      });
    });
  });

  describe('edit an update', () => {
    const editUpdateMutation = gqlV2/* GraphQL */ `
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
      expect(result.errors[0].message).to.equal('You must be logged in to edit this update');
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
    const deleteUpdateMutation = gqlV2/* GraphQL */ `
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
      expect(result.errors[0].message).to.equal('You must be logged in to delete this update');
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
      expect(result.errors[0].message).to.equal("You don't have sufficient permissions to delete this update");
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
