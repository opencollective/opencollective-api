/**
 * Dependencies.
 */

const constants = require('../constants');

/**
 * Controller.
 */

module.exports = (app) => {

  // const errors = app.errors;
  const models = app.set('models');
  const Expense = models.Expense;

  const createNewExpenseActivity = (id) => {

    return Expense.findOne({
      where: { id },
      include: [
        { model: models.Group },
        { model: models.User }
      ]
    })
    .then(expense => {
      return models.Activity.create({
        type: constants.activities.GROUP_EXPENSE_CREATED,
        ExpenseId: expense.id,
        UserId: expense.User.id,
        GroupId: expense.Group.id,
        data: {
          group: expense.Group.info,
          user: expense.User.info,
          expense: expense.info
        }
      });
    });
  };

  /**
   * Create an expense and add it to a group.
   */

  const create = (req, res, next) => {
    const attributes = req.required.expense;
    const group = req.group;
    const user = req.remoteUser || req.user || {};

    Expense.create(attributes)
      .tap(expense => expense.setUser(user))
      .tap(expense => expense.setGroup(group))
      .tap(expense => createNewExpenseActivity(expense.id))
      .then(expense => res.send(expense))
      .catch(next);
  };

  return {
    create
  };

};
