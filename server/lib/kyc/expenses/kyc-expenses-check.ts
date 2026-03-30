import Express from 'express';

import { expenseStatus } from '../../../constants';
import activities from '../../../constants/activities';
import { CollectiveType } from '../../../constants/collectives';
import { Collective, Op, PayoutMethod } from '../../../models';
import Expense from '../../../models/Expense';
import { KYCVerification, KYCVerificationStatus } from '../../../models/KYCVerification';
import { Level, Scope, SecurityCheck } from '../../security/expense';
import { KYCProviderName } from '../providers';

type ExpenseKYCStatus = {
  latestVerification: KYCVerification | null;
  payee: {
    status: 'NOT_REQUESTED' | 'PENDING' | 'VERIFIED';
  };
};

export async function expenseKycStatus(
  expense: Expense,
  { loaders }: { loaders?: Express.Request['loaders'] } = {},
): Promise<ExpenseKYCStatus | null> {
  if (expense.status === expenseStatus.DRAFT) {
    return null;
  }

  const payee = await (loaders
    ? loaders.Collective.byId.load(expense.FromCollectiveId)
    : Collective.findByPk(expense.FromCollectiveId));

  if (payee.type !== CollectiveType.USER) {
    return null;
  }

  let host =
    expense.host ||
    (expense.HostCollectiveId &&
      (loaders
        ? await loaders.Collective.byId.load(expense.HostCollectiveId)
        : await Collective.findByPk(expense.HostCollectiveId)));
  if (!host) {
    const collective =
      expense.collective ||
      (await (loaders
        ? loaders.Collective.byId.load(expense.CollectiveId)
        : Collective.findByPk(expense.CollectiveId)));
    const hostId = collective?.HostCollectiveId;
    host = hostId ? (loaders ? await loaders.Collective.byId.load(hostId) : await Collective.findByPk(hostId)) : null;
  }
  if (!host) {
    return null;
  }

  const kycRequests = (
    await Promise.all(
      Object.values(KYCProviderName).map(provider =>
        loaders
          ? loaders.KYCVerification.latestKycRequestsByProvider(host.id, provider).load(payee.id)
          : KYCVerification.findOne({
              where: {
                CollectiveId: payee.id,
                provider,
                RequestedByCollectiveId: host.id,
              },
              order: [['createdAt', 'DESC']],
            }),
      ),
    )
  ).filter(Boolean) as KYCVerification[];

  const hasKycRequests =
    kycRequests.filter(kycRequest =>
      [KYCVerificationStatus.VERIFIED, KYCVerificationStatus.PENDING].includes(kycRequest.status),
    ).length > 0;
  const isVerified =
    hasKycRequests && kycRequests.some(kycRequest => kycRequest.status === KYCVerificationStatus.VERIFIED);

  return {
    latestVerification: kycRequests.length > 0 ? kycRequests[0] : null,
    payee: {
      status: !hasKycRequests ? 'NOT_REQUESTED' : isVerified ? 'VERIFIED' : 'PENDING',
    },
  };
}

export async function handleExpensePayoutMethodChange(
  expense: Expense,
  oldPayoutMethod: PayoutMethod,
  newPayoutMethod: PayoutMethod,
) {
  if (oldPayoutMethod.id === newPayoutMethod.id) {
    return;
  }

  const kycStatus = await expenseKycStatus(expense);
  if (!kycStatus) {
    return;
  }

  if (kycStatus.payee.status !== 'VERIFIED') {
    return;
  }

  const collective = expense.collective || (await expense.getCollective());
  const hostId = expense.HostCollectiveId || collective.HostCollectiveId;
  if (newPayoutMethod.updatedAt > kycStatus.latestVerification?.verifiedAt) {
    await recordKycPayoutMethodChange(expense, hostId, oldPayoutMethod.dataValues, newPayoutMethod.dataValues);
  }
}

export async function handleKycPayoutMethodEdited(
  oldPayoutMethodDataValues: PayoutMethod['dataValues'],
  newPayoutMethod: PayoutMethod,
) {
  // find expenses that use the payout method
  const expenses = await Expense.findAll({
    where: {
      PayoutMethodId: newPayoutMethod.id,
      status: {
        [Op.notIn]: [expenseStatus.PAID, expenseStatus.DRAFT],
      },
    },
  });

  for (const expense of expenses) {
    await handleExpensePayoutMethodEdited(expense, oldPayoutMethodDataValues, newPayoutMethod);
  }
}

async function handleExpensePayoutMethodEdited(
  expense: Expense,
  oldPayoutMethodDataValues: PayoutMethod['dataValues'],
  newPayoutMethod: PayoutMethod,
) {
  const kycStatus = await expenseKycStatus(expense);
  if (!kycStatus) {
    return;
  }

  if (kycStatus.payee.status !== 'VERIFIED') {
    return;
  }

  const collective = expense.collective || (await expense.getCollective());
  const hostId = expense.HostCollectiveId || collective.HostCollectiveId;
  if (newPayoutMethod.updatedAt > kycStatus.latestVerification?.verifiedAt) {
    await recordKycPayoutMethodChange(expense, hostId, oldPayoutMethodDataValues, newPayoutMethod.dataValues);
  }
}

export async function handleKycPayoutMethodReplaced(oldPayoutMethod: PayoutMethod, newPayoutMethod: PayoutMethod) {
  // find expenses that use the payout method
  const expenses = await Expense.findAll({
    where: {
      PayoutMethodId: newPayoutMethod.id,
      status: {
        [Op.notIn]: [expenseStatus.PAID, expenseStatus.DRAFT],
      },
    },
  });

  for (const expense of expenses) {
    await handleExpensePayoutMethodChange(expense, oldPayoutMethod, newPayoutMethod);
  }
}

async function recordKycPayoutMethodChange(
  expense: Expense,
  // still not used, but might be useful to diff payout method changes
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  hostId: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  oldPayoutMethodDataValues: PayoutMethod['dataValues'],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  newPayoutMethodDataValues: PayoutMethod['dataValues'],
) {
  await expense.createActivity(activities.COLLECTIVE_EXPENSE_KYC_PAYOUT_METHOD_CHANGED, null, {});
}

export async function handleExpenseKycRequested(kycVerification: KYCVerification) {
  const expenses = await Expense.findAll({
    where: {
      FromCollectiveId: kycVerification.CollectiveId,
      status: {
        [Op.notIn]: [expenseStatus.PAID, expenseStatus.DRAFT],
      },
    },
    include: [
      {
        model: Collective,
        as: 'collective',
        required: true,
        where: {
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      },
    ],
  });

  for (const expense of expenses) {
    await expense.createActivity(
      activities.COLLECTIVE_EXPENSE_KYC_REQUESTED,
      { id: kycVerification.CreatedByUserId },
      {},
    );
  }
}

export async function handleExpenseKycVerified(kycVerification: KYCVerification) {
  const expenses = await Expense.findAll({
    where: {
      FromCollectiveId: kycVerification.CollectiveId,
      status: {
        [Op.notIn]: [expenseStatus.PAID, expenseStatus.DRAFT],
      },
    },
    include: [
      {
        model: Collective,
        as: 'collective',
        required: true,
        where: {
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      },
    ],
  });

  for (const expense of expenses) {
    await expense.createActivity(
      activities.COLLECTIVE_EXPENSE_KYC_VERIFIED,
      { id: kycVerification.CreatedByUserId },
      {},
    );
  }
}

export async function handleExpenseKycRevoked(kycVerification: KYCVerification) {
  const expenses = await Expense.findAll({
    where: {
      FromCollectiveId: kycVerification.CollectiveId,
      status: {
        [Op.notIn]: [expenseStatus.PAID, expenseStatus.DRAFT],
      },
    },
    include: [
      {
        model: Collective,
        as: 'collective',
        required: true,
        where: {
          HostCollectiveId: kycVerification.RequestedByCollectiveId,
        },
      },
    ],
  });

  for (const expense of expenses) {
    await expense.createActivity(
      activities.COLLECTIVE_EXPENSE_KYC_REVOKED,
      { id: kycVerification.CreatedByUserId },
      {},
    );
  }
}

export async function handleExpenseKycSecurityChecks(
  expense: Expense,
  checks: SecurityCheck[],
  { loaders }: { loaders?: Express.Request['loaders'] },
) {
  const expenseKYCStatus = await expenseKycStatus(expense, { loaders });
  if (!expenseKYCStatus) {
    return;
  }

  if (expenseKYCStatus.payee.status === 'VERIFIED') {
    checks.push({
      scope: Scope.PAYEE,
      level: Level.PASS,
      message: 'KYC Verified',
    });
  } else if (expenseKYCStatus.payee.status === 'PENDING') {
    checks.push({
      scope: Scope.PAYEE,
      level: Level.HIGH,
      message: 'KYC Verification pending',
    });
  }
}
