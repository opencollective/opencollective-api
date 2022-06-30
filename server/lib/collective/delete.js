import { types } from '../../constants/collectives';
import models, { Op } from '../../models';

const { EVENT, PROJECT, USER } = types;

export async function isCollectiveDeletable(collective) {
  let user;
  if (collective.type === USER) {
    user = await models.User.findOne({ where: { CollectiveId: collective.id } });
  }

  const transactionCount = await models.Transaction.count({
    where: {
      [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
    },
  });

  let expenseCount;
  if (user) {
    expenseCount = await models.Expense.count({
      where: {
        [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }, { UserId: user.id }],
        status: 'PAID',
      },
    });
  } else {
    expenseCount = await models.Expense.count({
      where: {
        [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }],
        status: 'PAID',
      },
    });
  }

  const eventOrProjectCount = await models.Collective.count({
    where: { ParentCollectiveId: collective.id, type: { [Op.in]: [EVENT, PROJECT] } },
  });

  if (transactionCount > 0 || expenseCount > 0 || eventOrProjectCount > 0) {
    return false;
  }

  return true;
}

export async function deleteCollective(collective) {
  const user = await models.User.findOne({ where: { CollectiveId: collective.id } });

  if (user) {
    await models.Expense.destroy({
      where: { [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }, { UserId: user.id }] },
    });
  } else {
    await models.Expense.destroy({
      where: { [Op.or]: [{ CollectiveId: collective.id }, { FromCollectiveId: collective.id }] },
    });
  }

  await models.PaymentMethod.destroy({ where: { CollectiveId: collective.id } });

  await models.ConnectedAccount.destroy({ where: { CollectiveId: collective.id } });

  // Update collective slug to free the current slug for future
  const newSlug = `${collective.slug}-${Date.now()}`;
  await collective.update({ slug: newSlug });

  await collective.destroy();

  return collective;
}
