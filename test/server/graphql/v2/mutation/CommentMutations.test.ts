import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { assert, createSandbox } from 'sinon';

import ActivityTypes from '../../../../../server/constants/activities';
import ExpenseStatuses from '../../../../../server/constants/expense_status';
import { idDecode, idEncode } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { fakeCollective, fakeComment, fakeExpense, fakeHost, fakeUser } from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

const gqlV2 = gql;

describe('test/server/graphql/v2/mutation/CommentMutations', () => {
  let validCommentData, collective, expense, admin, hostAdmin, expenseSubmitter;

  before(async () => {
    await utils.resetTestDB();
    admin = await fakeUser();
    hostAdmin = await fakeUser();
    expenseSubmitter = await fakeUser();
    const host = await fakeHost({ admin: hostAdmin.collective });
    collective = await fakeCollective({ admin: admin.collective, HostCollectiveId: host.id });
    expense = await fakeExpense({
      FromCollectiveId: expenseSubmitter.CollectiveId,
      UserId: expenseSubmitter.id,
      CollectiveId: collective.id,
      description: 'Test expense mutations',
    });
    validCommentData = {
      html: '<p>This is the <strong>comment</strong></p>',
      expense: { legacyId: expense.id },
    };
  });

  describe('create a comment', () => {
    let sandbox, sendEmailSpy;
    const createCommentMutation = gqlV2/* GraphQL */ `
      mutation CreateComment($comment: CommentCreateInput!) {
        createComment(comment: $comment) {
          id
          html
        }
      }
    `;

    before(() => {
      sandbox = createSandbox();
      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(createCommentMutation, { comment: validCommentData });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You must be logged in to create a comment');
    });

    it('creates a comment & sends an email', async () => {
      const result = await utils.graphqlQueryV2(createCommentMutation, { comment: validCommentData }, expenseSubmitter);
      utils.expectNoErrorsFromResult(result);
      const createdComment = result.data.createComment;
      expect(createdComment.html).to.equal('<p>This is the <strong>comment</strong></p>');

      // Creates the activity
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.EXPENSE_COMMENT_CREATED, ExpenseId: expense.id },
      });
      expect(activity).to.exist;
      expect(activity.data.CommentId).to.equal(idDecode(createdComment.id, 'comment'));

      // Sends an email
      await utils.waitForCondition(() => sendEmailSpy.callCount === 2);
      expect(sendEmailSpy.callCount).to.equal(2);
      const expectedTitle = `${collective.name}: New comment on expense ${expense.description} by ${expenseSubmitter.collective.name}`;
      assert.calledWithMatch(sendEmailSpy, admin.email, expectedTitle);
      assert.calledWithMatch(sendEmailSpy, hostAdmin.email, expectedTitle);
    });

    it('moves the expense back to APPROVED if its current status is INCOMPLETE', async () => {
      await expense.update({ status: ExpenseStatuses.INCOMPLETE });

      let result = await utils.graphqlQueryV2(createCommentMutation, { comment: validCommentData }, hostAdmin);
      utils.expectNoErrorsFromResult(result);
      await expense.reload();
      expect(expense.status).to.equal(ExpenseStatuses.INCOMPLETE);

      result = await utils.graphqlQueryV2(createCommentMutation, { comment: validCommentData }, expenseSubmitter);
      utils.expectNoErrorsFromResult(result);
      const createdComment = result.data.createComment;
      expect(createdComment.html).to.equal('<p>This is the <strong>comment</strong></p>');

      await expense.reload();
      expect(expense.status).to.equal(ExpenseStatuses.APPROVED);
    });
  });

  describe('edit a comment', () => {
    let comment;
    const editCommentMutation = gqlV2/* GraphQL */ `
      mutation EditComment($comment: CommentUpdateInput!) {
        editComment(comment: $comment) {
          id
          html
        }
      }
    `;

    before(async () => {
      comment = await fakeComment({
        ExpenseId: expense.id,
        FromCollectiveId: admin.CollectiveId,
        CollectiveId: expense.CollectiveId,
      });
    });

    it('fails to delete a comment if not logged in', async () => {
      const result = await utils.graphqlQueryV2(editCommentMutation, {
        comment: { id: idEncode(comment.id) },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You must be logged in to edit this comment');
    });

    it('fails if not authenticated as author or admin of collective', async () => {
      const user = await fakeUser();
      const result = await utils.graphqlQueryV2(editCommentMutation, { comment: { id: idEncode(comment.id) } }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You must be the author or an admin of this collective to edit this comment',
      );
    });

    it('edits a comment successfully', async () => {
      const html = '<p>new <em>comment</em> text</p>';
      const result = await utils.graphqlQueryV2(
        editCommentMutation,
        { comment: { id: idEncode(comment.id), html } },
        admin,
      );
      utils.expectNoErrorsFromResult(result);

      // Check the returned edited comment has the correct value.
      expect(result.data.editComment.html).to.equal(html);

      // Check the database has the correct value.
      const commentFromDb = await models.Comment.findByPk(comment.id);
      expect(commentFromDb.html).to.equal(html);
    });
  });

  describe('delete Comment', () => {
    let comment;
    const deleteCommentMutation = gqlV2/* GraphQL */ `
      mutation DeleteComment($id: String!) {
        deleteComment(id: $id) {
          id
        }
      }
    `;

    before(async () => {
      comment = await fakeComment({
        ExpenseId: expense.id,
        FromCollectiveId: admin.CollectiveId,
        CollectiveId: expense.CollectiveId,
      });
    });

    it('fails to delete a comment if not logged in', async () => {
      const result = await utils.graphqlQueryV2(deleteCommentMutation, { id: idEncode(comment.id, 'comment') });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You must be logged in to delete this comment');
      return models.Comment.findByPk(comment.id).then(commentFound => {
        expect(commentFound).to.not.be.null;
      });
    });

    it('fails to delete a comment if logged in as another user', async () => {
      const user = await fakeUser();
      const result = await utils.graphqlQueryV2(deleteCommentMutation, { id: idEncode(comment.id, 'comment') }, user);
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You need to be logged in as a core contributor or as a host to delete this comment',
      );
      return models.Comment.findByPk(comment.id).then(commentFound => {
        expect(commentFound).to.not.be.null;
      });
    });

    it('deletes a comment', async () => {
      const result = await utils.graphqlQueryV2(deleteCommentMutation, { id: idEncode(comment.id, 'comment') }, admin);
      utils.expectNoErrorsFromResult(result);
      expect(result.errors).to.not.exist;
      return models.Comment.findByPk(comment.id).then(commentFound => {
        expect(commentFound).to.be.null;
      });
    });
  });
});
