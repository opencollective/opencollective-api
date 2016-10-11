import app from '../server/index';
import { expect } from 'chai';
import Promise from 'bluebird';
import request from 'supertest-as-promised';
import * as utils from '../test/utils';
import roles from '../server/constants/roles';
import { badRequest, missingRequired } from './lib/expectHelpers';
import models from '../server/models';
import activities from '../server/constants/activities';

const application = utils.data('application');

describe('comments.routes.test.js', () => {
  let host, member, user, group, expense;

  beforeEach(() => utils.resetTestDB());

  beforeEach('create host', () => models.User.create(utils.data('user1')).tap(u => host = u));
  beforeEach('create member', () => models.User.create(utils.data('user2')).tap(u => member = u));
  beforeEach('create user', () => models.User.create(utils.data('user3')).tap(u => user = u));

  beforeEach('create group', () => models.Group.create(utils.data('group1')).tap(g => group = g));

  beforeEach('add host to group', () => group.addUserWithRole(host, roles.HOST));
  beforeEach('add member to group', () => group.addUserWithRole(member, roles.MEMBER));
  beforeEach('create expense', () => models.Expense.create(Object.assign({}, utils.data('expense1'), { UserId: member.id, GroupId: group.id, lastEditedById: member.id })).tap(e => expense = e));

  describe('#create', () => {

    it('creates a new comment for a logged in user', () => {
      return request(app)
        .post(`/groups/${group.id}/expenses/${expense.id}/comments?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .send({comment: utils.data('comments')[0] })
        .expect(200)
        .then(res => {
          const result = res.body.data;
          expect(result.comment.text).to.equal(utils.data('comments')[0].text);
          expect(result.group.name).to.equal(utils.data('group1').name);
          expect(result.expense.title).to.equal(utils.data('expense1').title);
        });
    });

    it('creates a new comment and a new user', () => {
      return request(app)
        .post(`/groups/${group.id}/expenses/${expense.id}/comments?api_key=${application.api_key}`)
        .send({comment: utils.data('comments')[1], user: utils.data('user4') })
        .expect(200)
        .then(res => {
          const result = res.body.data;
          expect(result.comment.text).to.equal(utils.data('comments')[1].text);
          expect(result.user.email).to.equal(utils.data('user4').email);
          expect(result.expense.title).to.equal(utils.data('expense1').title);
        });
    });
  });

  describe('#delete', () => {
    let comment;
    beforeEach(() => models.Comment.create(Object.assign({}, utils.data('comments')[0], { UserId: member.id, GroupId: group.id, ExpenseId: expense.id })).tap(c => comment = c))

    it('deletes a comment if logged in as author', () => {
      return request(app)
        .delete(`/groups/${group.id}/expenses/${expense.id}/comments/${comment.id}?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${member.jwt()}`)
        .expect(200)
        .then(res => {
          expect(res.body.type).to.equal(activities.GROUP_COMMENT_DELETED);
        });
    });

    it('deletes a comment if logged in as host or admin (member)', () => {
      return request(app)
        .delete(`/groups/${group.id}/expenses/${expense.id}/comments/${comment.id}?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${host.jwt()}`)
        .expect(200)
        .then(res => {
          expect(res.body.type).to.equal(activities.GROUP_COMMENT_DELETED);
        });
    });

    it('fails if not logged in', () => {
      return request(app)
        .delete(`/groups/${group.id}/expenses/${expense.id}/comments/${comment.id}?api_key=${application.api_key}`)
        .expect(401);
    });

    it('fails to delete if not logged in as author or host or admin member', () => {
      return request(app)
        .delete(`/groups/${group.id}/expenses/${expense.id}/comments/${comment.id}?api_key=${application.api_key}`)
        .set('Authorization', `Bearer ${user.jwt()}`)
        .expect(403);
    });

  });

  describe('#list', () => {
    beforeEach('create many comments', () => models.Comment.createMany(utils.data('comments'), { UserId: member.id, GroupId: group.id, ExpenseId: expense.id }));

    it('gets the list of comments for a given expense', () => {
      return request(app)
        .get(`/groups/${group.id}/expenses/${expense.id}/comments?api_key=${application.api_key}`)
        .expect(200)
        .then(res => {
          const comments = res.body;
          expect(comments.length).to.equal(3);
        });
    });

  });
});