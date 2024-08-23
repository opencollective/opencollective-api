import express from 'express';
import { cloneDeepWith, pick } from 'lodash';
import { InferAttributes } from 'sequelize';

import { testStripeAccounts } from '../../../scripts/sanitize-db';
import { randEmail, randStr } from '../../../test/test-helpers/fake-data';
import Channels from '../../constants/channels';
import { sanitizeActivityData } from '../../graphql/common/activities';
import { canSeeComment } from '../../graphql/common/comment';
import {
  allowContextPermission,
  getContextPermission,
  PERMISSION_TYPE,
} from '../../graphql/common/context-permissions';
import * as ExpenseLib from '../../graphql/common/expenses';
import * as OrdersLib from '../../graphql/common/orders';
import { canSeeUpdate } from '../../graphql/common/update';
import { Agreement, Collective, LegalDocument, ModelInstance, type ModelNames } from '../../models';
import { IDENTIFIABLE_DATA_FIELDS } from '../../models/PayoutMethod';

import { PartialRequest } from './types';

const TEST_STRIPE_ACCOUNTS = Object.values(testStripeAccounts).reduce(
  (obj, account) => ({ ...obj, [account.CollectiveId]: account }),
  {},
);

const DEV_SANITIZERS = {
  ConnectedAccount: values => TEST_STRIPE_ACCOUNTS[values.CollectiveId] || { token: randStr('tok_') },
  PaymentMethod: values => ({
    token: randStr('tok_'),
    customerId: randStr('cus_'),
    data: cloneDeepWith(values.data, (value, key) => {
      if (key === 'customerIdForHost') {
        return {};
      } else if (key === 'fullName') {
        return randStr('name_');
      } else if (
        ['orderID', 'payerID', 'paymentID', 'returnUrl', 'paymentToken', 'subscriptionId', 'fingerprint'].includes(
          key as string,
        )
      ) {
        return randStr();
      } else if (key === 'email') {
        return randEmail();
      }
    }),
    name: values.service === 'paypal' ? randEmail() : values.name,
  }),
  PayoutMethod: values => ({
    data: cloneDeepWith(values.data, (value, key) => {
      if (['postCode', 'firstLine', ...IDENTIFIABLE_DATA_FIELDS].includes(key as string)) {
        return randStr();
      } else if (key === 'accountHolderName') {
        return randStr('name_');
      } else if (key === 'email') {
        return randEmail();
      }
    }),
  }),
  User: values => ({
    email: randEmail(),
    twoFactorAuthToken: null,
    twoFactorAuthRecoveryCodes: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    data: cloneDeepWith(values.data, (value, key) => {
      if (key === 'lastSignInRequest') {
        return {};
      }
    }),
  }),
  UserTwoFactorMethod: () => null,
};

type Sanitizer<ModelName extends ModelNames> = (
  values: ModelInstance<ModelName>,
  req: PartialRequest,
) =>
  | void
  | null
  | Partial<InferAttributes<ModelInstance<ModelName>>>
  | Promise<void | null | Partial<InferAttributes<ModelInstance<ModelName>>>>;

// We enforce all models to be defined in this one as we don't want to forget to add a new models.
const PROD_SANITIZERS: { [k in ModelNames]: Sanitizer<k> } = {
  // Things that we never want to export. Returning null will exclude them from the dump.
  Application: () => null,
  ConnectedAccount: () => null,
  MemberInvitation: () => null,
  MigrationLog: () => null,
  OAuthAuthorizationCode: () => null,
  PersonalToken: () => null,
  SuspendedAsset: () => null, // Private platform data
  TransactionSettlement: () => null, // Doesn't make sense to export since it's moving out of the platform
  UserToken: () => null,
  UserTwoFactorMethod: () => null,
  // Things that don't need any redaction.
  AccountingCategory: () => {},
  EmojiReaction: () => {},
  Conversation: () => {},
  ConversationFollower: () => {},
  CurrencyExchangeRate: () => {},
  Member: () => {},
  PaypalPlan: () => {},
  PaypalProduct: () => {},
  RecurringExpense: () => {}, // Private data only exists in the expense itself
  RequiredLegalDocument: () => {}, // Not the legal documents themselves, just the requirements
  SocialLink: () => {},
  UploadedFile: () => {},
  // Things that we want to export, but with some fields redacted.
  Activity: async (activity, req) => ({
    data: await sanitizeActivityData(req, activity),
  }),
  Agreement: (agreement, req) => {
    if (!Agreement.canSeeAgreementsForHostCollectiveId(req.remoteUser, agreement.HostCollectiveId)) {
      return null;
    }
  },
  Collective: async (collective, req) => {
    req.loaders.Collective.byId.prime(collective.id, collective); // Store the collective in the cache for later row resolvers
    const canSeePrivateInfo = await req.loaders.Collective.canSeePrivateInfo.load(collective.id);
    const publicDataFields = [
      'features',
      'policies',
      'isTrustedHost',
      'isFirstPartyHost',
      'hostFeePercent',
      'addedFundsHostFeePercent',
      'bankTransfersHostFeePercent',
      'reimbursePaymentProcessorFeeOnTips',
      'isGuest',
      'useCustomHostFee',
      'stripeNotPlatformTipEligibleHostFeePercent',
      'paypalNotPlatformTipEligibleHostFeePercent',
    ];
    const privateDataFields = ['address', 'replyToEmail', 'vendorInfo'];
    return {
      legalName: canSeePrivateInfo ? collective.legalName : null,
      CreatedByUserId: !collective.isIncognito || canSeePrivateInfo ? collective.CreatedByUserId : null,
      location: canSeePrivateInfo ? collective.location : null,
      data: pick(collective.data, canSeePrivateInfo ? [...publicDataFields, ...privateDataFields] : privateDataFields),
    };
  },
  Comment: async (comment, req) => {
    if (!(await canSeeComment(req, comment))) {
      return null;
    }
  },
  Expense: async (expense, req) => {
    req.loaders.Expense.byId.prime(expense.id, expense); // Store the expense in the cache for later row resolvers
    if (await ExpenseLib.canSeeExpensePayoutMethodPrivateDetails(req as express.Request, expense)) {
      allowContextPermission(req as express.Request, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, expense.PayoutMethodId);
    }

    return {
      payeeLocation: (await ExpenseLib.canSeeExpensePayeeLocation(req as express.Request, expense))
        ? expense.payeeLocation
        : null,
      privateMessage: (await ExpenseLib.canSeeExpenseAttachments(req as express.Request, expense))
        ? expense.privateMessage
        : null,
      invoiceInfo: (await ExpenseLib.canSeeExpenseInvoiceInfo(req as express.Request, expense))
        ? expense.invoiceInfo
        : null,
      data: (await ExpenseLib.isHostAdmin(req as express.Request, expense)) ? expense.data : null,
    };
  },
  ExpenseAttachedFile: async (file, req) => {
    const expense = await req.loaders.Expense.byId.load(file.ExpenseId);
    if (!expense || !(await ExpenseLib.canSeeExpenseAttachments(req as express.Request, expense))) {
      return null;
    }
  },
  ExpenseItem: async (item, req) => {
    const expense = await req.loaders.Expense.byId.load(item.ExpenseId);
    return {
      url: (await ExpenseLib.canSeeExpenseAttachments(req as express.Request, expense)) ? item.url : null,
    };
  },
  HostApplication: async (application, req) => {
    if (!req.remoteUser.isAdmin(application.CollectiveId) && !req.remoteUser.isAdmin(application.HostCollectiveId)) {
      return { customData: null, message: null };
    }
  },
  LegalDocument: async (values: LegalDocument) => ({
    // Legal documents don't yet have dedicated permissions loaders. Until we implement them, the simplest option
    // is to strip the raw data entirely. Doing so should not prevent the feature from working, as the data is only there for the audit trail.
    // The `url` is also safe as it can't be downloaded without the proper s3 credentials.
    data: pick(values.data, ['service', 'reminderSentAt']),
  }),
  Location: async (location, req) => {
    const collective: Collective = await req.loaders.Collective.byId.load(location.CollectiveId);
    if (!collective) {
      return null;
    } else if (!collective.hasPublicLocation()) {
      const canSeePrivateInfo = await req.loaders.Collective.canSeePrivateInfo.load(collective.id);
      if (!canSeePrivateInfo) {
        return null;
      }
    }
  },
  Notification: async notification => {
    if (notification.channel !== Channels.EMAIL) {
      return null;
    }
  },
  Order: async (order, req) => {
    req.loaders.Order.byId.prime(order.id, order); // Store the order in the cache for later row resolvers
    const publicDataFields = [
      'hostFeePercent',
      'paymentProcessorFee',
      'tax',
      'isBalanceTransfer',
      'isGuest',
      'isPendingContribution',
      'platformTip',
    ];

    const privateDataFields = [
      'needsConfirmation',
      'paypalStatusChangeNote',
      'memo',
      'paymentIntent',
      'previousPaymentIntents',
      'customData',
      'savePaymentMethod',
      'messageForContributors',
      'messageSource',
      'closedReason',
    ];

    const isHostAdmin = await OrdersLib.isOrderHostAdmin(req as express.Request, order);
    if (isHostAdmin) {
      allowContextPermission(req as express.Request, PERMISSION_TYPE.SEE_PAYMENT_METHOD_DETAILS, order.PaymentMethodId);
      allowContextPermission(
        req as express.Request,
        PERMISSION_TYPE.SEE_SUBSCRIPTION_PRIVATE_DETAILS,
        order.SubscriptionId,
      );
    }

    return {
      privateMessage: null, // This field is not used since 2017, we don't want to export it
      CreatedByUserId: (await OrdersLib.canSeeOrderCreator(req as express.Request, order))
        ? order.CreatedByUserId
        : null,
      data: pick(order.data, isHostAdmin ? [...publicDataFields, ...privateDataFields] : publicDataFields),
    };
  },
  PaymentMethod: async (paymentMethod, req) => {
    if (!getContextPermission(req as express.Request, PERMISSION_TYPE.SEE_PAYMENT_METHOD_DETAILS, paymentMethod.id)) {
      return {
        uuid: null,
        CreatedByUserId: null,
        data: null,
        customerId: null,
        name: null,
        expiryDate: null,
        currency: 'USD',
      };
    }
  },
  PayoutMethod: (payoutMethod, req) => {
    if (!getContextPermission(req as express.Request, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, payoutMethod.id)) {
      return {
        data: {},
        isSaved: false,
        name: null,
      };
    }
  },
  Subscription: (subscription, req) => {
    if (
      !getContextPermission(req as express.Request, PERMISSION_TYPE.SEE_SUBSCRIPTION_PRIVATE_DETAILS, subscription.id)
    ) {
      return {
        data: null,
        interval: null,
        isActive: null,
        stripeSubscriptionId: null,
      };
    }
  },
  Tier: tier => ({
    data: pick(tier.data, ['invoiceTemplate', 'singleTicket', 'requireAddress']),
  }),
  Transaction: async (transaction, req) => {
    if (!req.remoteUser.isAdmin(transaction.HostCollectiveId)) {
      return {
        data: pick(transaction.data, ['invoiceTemplate', 'tax']),
      };
    }
  },
  TransactionsImport: async (transactionsImport, req) => {
    req.loaders.TransactionsImport.byId.prime(transactionsImport.id, transactionsImport); // Store the transactionsImport in the cache for later row resolvers
    return req.remoteUser.isAdmin(transactionsImport.CollectiveId) ? transactionsImport : null;
  },
  TransactionsImportRow: async (transactionsImportRow, req) => {
    const transactionsImport = await req.loaders.TransactionsImport.byId.load(
      transactionsImportRow.TransactionsImportId,
    );
    if (!transactionsImport || !req.remoteUser.isAdmin(transactionsImport.CollectiveId)) {
      return null;
    }
  },
  Update: async (update, req) => {
    if (!(await canSeeUpdate(req, update))) {
      return null;
    }
  },
  VirtualCard: (card, req) => {
    if (!req.remoteUser.isAdmin(card.HostCollectiveId)) {
      return null;
    }
  },
  VirtualCardRequest: (cardRequest, req) => {
    if (!req.remoteUser.isAdmin(cardRequest.HostCollectiveId)) {
      return null;
    }
  },
  User: () => ({
    confirmedAt: null,
    lastLoginAt: null,
    passwordHash: null,
    passwordUpdatedAt: null,
    emailWaitingForValidation: null,
    emailConfirmationToken: null,
    twoFactorAuthToken: null,
    yubikeyDeviceId: null,
    twoFactorAuthRecoveryCodes: null,
  }),
};

export const getSanitizers = ({ isDev = false } = {}): Partial<Record<ModelNames, Sanitizer<ModelNames>>> => {
  if (isDev) {
    return DEV_SANITIZERS;
  } else {
    return PROD_SANITIZERS;
  }
};
