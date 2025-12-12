import { expect } from 'chai';
import gql from 'fake-tag';
import { describe, it } from 'mocha';
import { assert, createSandbox } from 'sinon';

import { roles } from '../../../../../server/constants';
import ActivityTypes from '../../../../../server/constants/activities';
import { idDecode, idEncode } from '../../../../../server/graphql/v2/identifiers';
import emailLib from '../../../../../server/lib/email';
import models from '../../../../../server/models';
import { CommentType } from '../../../../../server/models/Comment';
import {
  fakeActiveHost,
  fakeCollective,
  fakeComment,
  fakeExpense,
  fakeMember,
  fakeProject,
  fakeUser,
} from '../../../../test-helpers/fake-data';
import * as utils from '../../../../utils';

describe('test/server/graphql/v2/mutation/CommentMutations', () => {
  let validCommentData, collective, expense, admin, hostAdmin, expenseSubmitter, host;

  before(async () => {
    await utils.resetTestDB();
    admin = await fakeUser(undefined, { name: 'The Collective Admin' });
    hostAdmin = await fakeUser(undefined, { name: 'The Host Admin' });
    expenseSubmitter = await fakeUser(undefined, { name: 'The Expense Submitter' });
    host = await fakeActiveHost({ name: 'Test Host', admin: hostAdmin.collective });
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
    const createCommentMutation = gql`
      mutation CreateComment($comment: CommentCreateInput!) {
        createComment(comment: $comment) {
          id
          html
        }
      }
    `;

    beforeEach(() => {
      sandbox = createSandbox();
      sendEmailSpy = sandbox.spy(emailLib, 'sendMessage');
    });

    afterEach(() => {
      sandbox.restore();
    });

    it('fails if not authenticated', async () => {
      const result = await utils.graphqlQueryV2(createCommentMutation, { comment: validCommentData });
      expect(result.errors).to.have.length(1);
      expect(result.errors[0].message).to.equal('You must be logged in to create a comment');
    });

    it('creates a comment & sends an email', async () => {
      const parentCollective = await fakeCollective({
        name: 'The P@rent Collective',
        admin: admin,
        HostCollectiveId: host.id,
      });
      const project = await fakeProject({
        name: 'The Pr0ject',
        ParentCollectiveId: parentCollective.id,
        HostCollectiveId: host.id,
      });
      const anotherProjectAdmin = await fakeUser();
      await project.addUserWithRole(anotherProjectAdmin, roles.ADMIN);
      const payee = await fakeUser(undefined, { name: 'The Payee' });
      const expense = await fakeExpense({
        FromCollectiveId: payee.CollectiveId,
        UserId: expenseSubmitter.id,
        CollectiveId: project.id,
        description: 'Test expense mutations',
      });
      const commentData = {
        ...validCommentData,
        expense: { legacyId: expense.id },
      };

      const result = await utils.graphqlQueryV2(createCommentMutation, { comment: commentData }, anotherProjectAdmin);
      utils.expectNoErrorsFromResult(result);
      const createdComment = result.data.createComment;
      expect(createdComment.html).to.equal('<p>This is the <strong>comment</strong></p>');

      // Creates the activity
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.EXPENSE_COMMENT_CREATED, ExpenseId: expense.id },
      });
      expect(activity).to.exist;
      expect(activity.data.CommentId).to.equal(idDecode(createdComment.id, 'comment'));
      expect(activity.data.expense.description).to.equal(expense.description);
      expect(activity.data.collective.name).to.equal(project.name);
      expect(activity.data.fromCollective.name).to.equal(payee.collective.name);
      expect(activity.FromCollectiveId).to.equal(anotherProjectAdmin.CollectiveId);

      // Sends an email
      await utils.waitForCondition(() => sendEmailSpy.callCount === 4);
      expect(sendEmailSpy.callCount).to.equal(4);
      const expectedTitle = `${project.name}: New comment on expense ${expense.description} by ${anotherProjectAdmin.collective.name}`;
      assert.calledWithMatch(sendEmailSpy, hostAdmin.email, expectedTitle);
      assert.calledWithMatch(sendEmailSpy, admin.email, expectedTitle);
      assert.calledWithMatch(sendEmailSpy, expenseSubmitter.email, expectedTitle);
      assert.calledWithMatch(sendEmailSpy, payee.email, expectedTitle);

      // General fields
      expect(sendEmailSpy.args[0][2]).to.include('Expense Info');
      expect(sendEmailSpy.args[0][3].text).to.include('Fiscal Host: Test Host');
      expect(sendEmailSpy.args[0][3].text).to.include('Collective: The P@rent Collective → The Pr0ject');
      expect(sendEmailSpy.args[0][3].text).to.include('Payee: The Payee');
      expect(sendEmailSpy.args[0][3].text).to.include('Status: Pending');
    });

    it('creates private notes without notifying users out of context', async () => {
      const anotherHostAdmin = await fakeUser();
      await fakeMember({ CollectiveId: host.id, MemberCollectiveId: anotherHostAdmin.CollectiveId, role: roles.ADMIN });
      const result = await utils.graphqlQueryV2(
        createCommentMutation,
        { comment: { ...validCommentData, type: CommentType.PRIVATE_NOTE } },
        hostAdmin,
      );
      utils.expectNoErrorsFromResult(result);
      const createdComment = result.data.createComment;
      expect(createdComment.html).to.equal('<p>This is the <strong>comment</strong></p>');

      // Creates the activity
      const activity = await models.Activity.findOne({
        where: { type: ActivityTypes.EXPENSE_COMMENT_CREATED, ExpenseId: expense.id },
        order: [['createdAt', 'DESC']],
      });
      expect(activity).to.exist;
      expect(activity.data.CommentId).to.equal(idDecode(createdComment.id, 'comment'));
      expect(activity.data.comment.type).to.equal(CommentType.PRIVATE_NOTE);

      // Sends an email
      await utils.waitForCondition(() => sendEmailSpy.callCount === 1);
      const expectedTitle = `${collective.name}: New comment on expense ${expense.description} by ${hostAdmin.collective.name}`;
      assert.neverCalledWithMatch(sendEmailSpy, admin.email);
      assert.neverCalledWithMatch(sendEmailSpy, expenseSubmitter.email);
      assert.calledWithMatch(sendEmailSpy, anotherHostAdmin.email, expectedTitle);
    });
  });

  describe('edit a comment', () => {
    let comment;
    const editCommentMutation = gql`
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
        comment: { id: idEncode(comment.id, 'comment') },
      });
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal('You must be logged in to edit this comment');
    });

    it('fails if not authenticated as author or admin of collective', async () => {
      const user = await fakeUser();
      const result = await utils.graphqlQueryV2(
        editCommentMutation,
        { comment: { id: idEncode(comment.id, 'comment') } },
        user,
      );
      expect(result.errors).to.exist;
      expect(result.errors[0].message).to.equal(
        'You must be the author, an admin, or a community manager of this collective to edit this comment',
      );
    });

    it('edits a comment successfully', async () => {
      const html = '<p>new <em>comment</em> text</p>';
      const result = await utils.graphqlQueryV2(
        editCommentMutation,
        { comment: { id: idEncode(comment.id, 'comment'), html } },
        admin,
      );
      utils.expectNoErrorsFromResult(result);

      // Check the returned edited comment has the correct value.
      result.errors && console.error(result.errors);
      expect(result.data.editComment.html).to.equal(html);

      // Check the database has the correct value.
      const commentFromDb = await models.Comment.findByPk(comment.id);
      expect(commentFromDb.html).to.equal(html);
    });
  });

  describe('delete Comment', () => {
    let comment;
    const deleteCommentMutation = gql`
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
        'You need to be logged in as the author, an admin, a community manager, or as a host to delete this comment',
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
