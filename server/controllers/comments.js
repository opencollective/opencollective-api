import _ from 'lodash';
import Promise from 'bluebird';
import activities from '../constants/activities';
import {getLinkHeader, getRequestedUrl} from '../lib/utils';
import roles from '../constants/roles';
import errors from '../lib/errors';
import models from '../models';
import * as auth from '../middleware/security/auth';

function createActivity(comment, type) {
  return models.Activity.create({
    type,
    UserId: comment.User.id,
    GroupId: comment.Group.id,
    ExpenseId: comment.Expense.id,
    data: {
      group: comment.Group.info,
      user: comment.User.info,
      expense: comment.Expense.info,
      comment: comment.info
    }
  });
}

/**
 * Create a comment
 */
export const create = (req, res, next) => {
  const user = req.remoteUser || req.user;
  const { group, expense } = req;
  const attributes = Object.assign({}, req.required.comment, {
    UserId: user.id,
    GroupId: group.id,
    ExpenseId: expense.id
  });
  models.Comment.create(attributes)
    .then(comment => models.Comment.findById(comment.id, { include: [ models.Group, models.User, models.Expense ]}))
    .then(comment => createActivity(comment, activities.GROUP_COMMENT_CREATED))
    .then(activity => res.send(activity))
    .catch(next);
};

/**
 * Get a comment
 */
export const getOne = (req, res) => {
  res.json(req.comment.info);
}

/**
 * Get comments
 */
export const list = (req, res, next) => {

  const where = { GroupId: req.group.id };

  if (req.expense)
    where.ExpenseId = req.expense.id;

  const query = Object.assign({
    where,
    order: [[req.sorting.key, req.sorting.dir]]
  }, req.pagination);

  return models.Comment.findAndCountAll(query)
    .then(comments => {
      // Set headers for pagination.
      req.pagination.total = comments.count;
      res.set({ Link: getLinkHeader(getRequestedUrl(req), req.pagination) });
      res.send(_.pluck(comments.rows, 'info'));
    })
    .catch(next);
};

/**
 * Delete a comment
 */
export const deleteComment = (req, res, next) => {
  const { comment } = req;
  models.Comment.findById(comment.id, { include: [ models.Group, models.User, models.Expense ]})
    .tap(comment => comment.destroy())
    .then(comment => createActivity(comment, activities.GROUP_COMMENT_DELETED))
    .then(activity => res.send(activity))
    .catch(next);
};

export const update = (req, res, next) => {
  const origComment = req.comment;
  const newComment = req.required.comment;
  const modifiableProps = ['text'];

  modifiableProps.forEach(prop => origComment[prop] = newComment[prop] || origComment[prop]);
  origComment.updatedAt = new Date();
  origComment.save()
    .tap(comment => createActivity(comment, activities.GROUP_COMMENT_UPDATED))
    .tap(comment => res.send(comment.info))
    .catch(next);
};