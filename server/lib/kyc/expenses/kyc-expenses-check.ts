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
  isIndividual: boolean;
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

  const payee = expense.fromCollective?.type
    ? expense.fromCollective
    : await (loaders
        ? loaders.Collective.byId.load(expense.FromCollectiveId)
        : Collective.findByPk(expense.FromCollectiveId));

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

  const isIndividual = payee.type === CollectiveType.USER;
  let subjectCollectiveIds: number[];
  if (isIndividual) {
    subjectCollectiveIds = [payee.id];
  } else {
    subjectCollectiveIds = loaders
      ? await loaders.Member.adminMemberCollectiveIdsOfCollective.load(payee.id)
      : await payee.getAdmins().then(admins => admins.map(a => a.id));
  }

  // Fetch the latest KYC request per provider for each subject collective.
  const kycRequests: KYCVerification[] = [];
  if (subjectCollectiveIds.length > 0) {
    const requestsBySubject = await Promise.all(
      subjectCollectiveIds.flatMap(subjectId =>
        Object.values(KYCProviderName).map(provider =>
          loaders
            ? loaders.KYCVerification.latestKycRequestsByProvider(host.id, provider).load(subjectId)
            : KYCVerification.findOne({
                where: {
                  CollectiveId: subjectId,
                  provider,
                  RequestedByCollectiveId: host.id,
                },
                order: [['createdAt', 'DESC']],
              }),
        ),
      ),
    );
    kycRequests.push(...(requestsBySubject.filter(Boolean) as KYCVerification[]));
  }

  const activeRequests = kycRequests.filter(r =>
    [KYCVerificationStatus.VERIFIED, KYCVerificationStatus.PENDING].includes(r.status),
  );
  const hasKycRequests = activeRequests.length > 0;

  let status: 'NOT_REQUESTED' | 'PENDING' | 'VERIFIED';
  if (!hasKycRequests) {
    status = 'NOT_REQUESTED';
  } else if (isIndividual) {
    status = activeRequests.some(r => r.status === KYCVerificationStatus.VERIFIED) ? 'VERIFIED' : 'PENDING';
  } else {
    const verifiedSubjectIds = new Set(
      activeRequests.filter(r => r.status === KYCVerificationStatus.VERIFIED).map(r => r.CollectiveId),
    );
    const pendingSubjectIds = new Set(
      activeRequests
        .filter(r => r.status === KYCVerificationStatus.PENDING && !verifiedSubjectIds.has(r.CollectiveId))
        .map(r => r.CollectiveId),
    );
    status = pendingSubjectIds.size > 0 ? 'PENDING' : 'VERIFIED';
  }

  return {
    latestVerification: kycRequests.length > 0 ? kycRequests[0] : null,
    isIndividual,
    payee: {
      status,
    },
  };
}

export async function handleExpensePayoutMethodChange(
  expense: Expense,
  oldPayoutMethod: PayoutMethod,
  newPayoutMethod: PayoutMethod,
) {
  if (oldPayoutMethod?.id === newPayoutMethod.id) {
    return;
  }

  const kycStatus = await expenseKycStatus(expense);
  if (!kycStatus) {
    return;
  }

  // Payout-method-change KYC activities only apply to individual payees today.
  if (!kycStatus.isIndividual || kycStatus.payee.status !== 'VERIFIED') {
    return;
  }

  const collective = expense.collective || (await expense.getCollective());
  const hostId = expense.HostCollectiveId || collective.HostCollectiveId;
  if (newPayoutMethod.updatedAt > kycStatus.latestVerification?.verifiedAt) {
    await recordKycPayoutMethodChange(expense, hostId, oldPayoutMethod?.dataValues, newPayoutMethod.dataValues);
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

  if (!kycStatus.isIndividual || kycStatus.payee.status !== 'VERIFIED') {
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
      message: expenseKYCStatus.isIndividual ? 'KYC Verified' : 'Account admin KYC verified',
    });
  } else if (expenseKYCStatus.payee.status === 'PENDING') {
    checks.push({
      scope: Scope.PAYEE,
      level: Level.HIGH,
      message: expenseKYCStatus.isIndividual ? 'KYC Verification pending' : 'Account admin KYC pending',
    });
  }
}
