/*
 * Constant strings used in the activity model
 */

enum ActivityTypes {
  ACTIVITY_ALL = 'all',
  // Accounting categories
  ACCOUNTING_CATEGORIES_EDITED = 'accounting.categories.edited',
  // Connected accounts
  CONNECTED_ACCOUNT_CREATED = 'connected_account.created', // Not used yet
  CONNECTED_ACCOUNT_ERROR = 'connected_account.error', // Not used yet
  // Collective creation & applications
  COLLECTIVE_CREATED_GITHUB = 'collective.created.github', // Not used since 2020-03-17
  COLLECTIVE_APPLY = 'collective.apply',
  COLLECTIVE_APPROVED = 'collective.approved',
  COLLECTIVE_REJECTED = 'collective.rejected',
  COLLECTIVE_CREATED = 'collective.created',
  COLLECTIVE_EDITED = 'collective.edited',
  COLLECTIVE_DELETED = 'collective.deleted',
  COLLECTIVE_UNHOSTED = 'collective.unhosted',
  ORGANIZATION_COLLECTIVE_CREATED = 'organization.collective.created',
  // Freezing collectives
  COLLECTIVE_FROZEN = 'collective.frozen',
  COLLECTIVE_UNFROZEN = 'collective.unfrozen',
  // Comments & conversations
  COLLECTIVE_CONVERSATION_CREATED = 'collective.conversation.created',
  UPDATE_COMMENT_CREATED = 'update.comment.created',
  EXPENSE_COMMENT_CREATED = 'expense.comment.created',
  CONVERSATION_COMMENT_CREATED = 'conversation.comment.created',
  ORDER_COMMENT_CREATED = 'order.comment.created',
  // Expenses
  COLLECTIVE_EXPENSE_CREATED = 'collective.expense.created',
  COLLECTIVE_EXPENSE_DELETED = 'collective.expense.deleted',
  COLLECTIVE_EXPENSE_UPDATED = 'collective.expense.updated',
  COLLECTIVE_EXPENSE_REJECTED = 'collective.expense.rejected',
  COLLECTIVE_EXPENSE_APPROVED = 'collective.expense.approved',
  COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED = 'collective.expense.reApprovalRequested',
  COLLECTIVE_EXPENSE_UNAPPROVED = 'collective.expense.unapproved',
  COLLECTIVE_EXPENSE_MOVED = 'collective.expense.moved',
  COLLECTIVE_EXPENSE_PAID = 'collective.expense.paid',
  COLLECTIVE_EXPENSE_MARKED_AS_UNPAID = 'collective.expense.unpaid',
  COLLECTIVE_EXPENSE_MARKED_AS_SPAM = 'collective.expense.spam',
  COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE = 'collective.expense.incomplete',
  COLLECTIVE_EXPENSE_PROCESSING = 'collective.expense.processing',
  COLLECTIVE_EXPENSE_PUT_ON_HOLD = 'collective.expense.putOnHold',
  COLLECTIVE_EXPENSE_RELEASED_FROM_HOLD = 'collective.expense.releasedFromHold',
  COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT = 'collective.expense.scheduledForPayment',
  COLLECTIVE_EXPENSE_UNSCHEDULED_FOR_PAYMENT = 'collective.expense.unscheduledForPayment',
  COLLECTIVE_EXPENSE_ERROR = 'collective.expense.error',
  COLLECTIVE_EXPENSE_INVITE_DRAFTED = 'collective.expense.invite.drafted',
  COLLECTIVE_EXPENSE_RECURRING_DRAFTED = 'collective.expense.recurring.drafted',
  COLLECTIVE_EXPENSE_MISSING_RECEIPT = 'collective.expense.missing.receipt',
  TAXFORM_REQUEST = 'taxform.request',
  // Virtual cards
  COLLECTIVE_VIRTUAL_CARD_ADDED = 'collective.virtualcard.added',
  COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS = 'collective.virtualcard.missing.receipts',
  COLLECTIVE_VIRTUAL_CARD_RESUMED = 'collective.virtualcard.resumed',
  COLLECTIVE_VIRTUAL_CARD_SUSPENDED = 'collective.virtualcard.suspended',
  COLLECTIVE_VIRTUAL_CARD_SUSPENDED_DUE_TO_INACTIVITY = 'collective.virtualcard.suspendedDueToInactivity',
  COLLECTIVE_VIRTUAL_CARD_DELETED = 'collective.virtualcard.deleted',
  COLLECTIVE_VIRTUAL_CARD_REQUEST_APPROVED = 'collective.virtualcard.request.approved',
  COLLECTIVE_VIRTUAL_CARD_REQUEST_REJECTED = 'collective.virtualcard.request.rejected',
  VIRTUAL_CARD_REQUESTED = 'virtual_card.requested',
  VIRTUAL_CARD_CHARGE_DECLINED = 'virtualcard.charge.declined',
  VIRTUAL_CARD_PURCHASE = 'virtualcard.purchase',
  // Members
  COLLECTIVE_MEMBER_INVITED = 'collective.member.invited',
  COLLECTIVE_MEMBER_CREATED = 'collective.member.created',
  COLLECTIVE_CORE_MEMBER_ADDED = 'collective.core.member.added',
  COLLECTIVE_CORE_MEMBER_INVITED = 'collective.core.member.invited',
  COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED = 'collective.core.member.invitation.declined',
  COLLECTIVE_CORE_MEMBER_REMOVED = 'collective.core.member.removed',
  COLLECTIVE_CORE_MEMBER_EDITED = 'collective.core.member.edited',
  // Transactions
  COLLECTIVE_TRANSACTION_CREATED = 'collective.transaction.created',
  // Updates
  COLLECTIVE_UPDATE_CREATED = 'collective.update.created',
  COLLECTIVE_UPDATE_PUBLISHED = 'collective.update.published',
  // Contact
  COLLECTIVE_CONTACT = 'collective.contact',
  HOST_APPLICATION_CONTACT = 'host.application.contact',
  // Contributions
  CONTRIBUTION_REJECTED = 'contribution.rejected',
  SUBSCRIPTION_ACTIVATED = 'subscription.activated',
  SUBSCRIPTION_CANCELED = 'subscription.canceled',
  TICKET_CONFIRMED = 'ticket.confirmed',
  ORDER_CANCELED_ARCHIVED_COLLECTIVE = 'order.canceled.archived.collective',
  ORDER_PENDING = 'order.pending',
  ORDER_PENDING_CONTRIBUTION_NEW = 'order.new.pendingFinancialContribution',
  ORDER_PENDING_CONTRIBUTION_REMINDER = 'order.reminder.pendingFinancialContribution',
  ORDER_PROCESSING = 'order.processing',
  ORDER_PAYMENT_FAILED = 'order.payment.failed',
  ORDER_CONFIRMED = 'order.confirmed',
  // Vendors
  VENDOR_CREATED = 'vendor.created',
  VENDOR_EDITED = 'vendor.edited',
  VENDOR_DELETED = 'vendor.deleted',

  // PENDING CONTRIBUTIONS
  ORDER_PENDING_CREATED = 'order.pending.created',
  ORDER_PENDING_FOLLOWUP = 'order.pending.followup',
  ORDER_PENDING_RECEIVED = 'order.pending.received',

  ORDERS_SUSPICIOUS = 'orders.suspicious',
  PAYMENT_FAILED = 'payment.failed',
  PAYMENT_CREDITCARD_CONFIRMATION = 'payment.creditcard.confirmation',
  PAYMENT_CREDITCARD_EXPIRING = 'payment.creditcard.expiring',
  // User signup/signin
  USER_CREATED = 'user.created',
  USER_NEW_TOKEN = 'user.new.token', // Replaced by USER_SIGNIN but still used in the email notification
  USER_SIGNIN = 'user.signin',
  USER_RESET_PASSWORD = 'user.resetPassword',
  OAUTH_APPLICATION_AUTHORIZED = 'oauth.application.authorized',
  TWO_FACTOR_METHOD_ADDED = 'user.new.two.factor.method',
  TWO_FACTOR_METHOD_DELETED = 'user.remove.two.factor.method',
  TWO_FACTOR_CODE_REQUESTED = 'user.requested.two.factor.code',
  // User edits
  USER_CHANGE_EMAIL = 'user.changeEmail',
  USER_PAYMENT_METHOD_CREATED = 'user.paymentMethod.created',
  USER_PASSWORD_SET = 'user.passwordSet',
  // Gift cards
  USER_CARD_CLAIMED = 'user.card.claimed',
  USER_CARD_INVITED = 'user.card.invited',
  // Webhooks
  WEBHOOK_STRIPE_RECEIVED = 'webhook.stripe.received',
  WEBHOOK_PAYPAL_RECEIVED = 'webhook.paypal.received',
  // Reports
  COLLECTIVE_MONTHLY_REPORT = 'collective.monthlyreport',
  // Host
  ACTIVATED_COLLECTIVE_AS_HOST = 'activated.collective.as.host',
  ACTIVATED_COLLECTIVE_AS_INDEPENDENT = 'activated.collective.as.independent',
  DEACTIVATED_COLLECTIVE_AS_HOST = 'deactivated.collective.as.host',

  // Agreements

  AGREEMENT_CREATED = 'agreement.created',
  AGREEMENT_EDITED = 'agreement.edited',
  AGREEMENT_DELETED = 'agreement.deleted',

  // Not used anymore, leaving for historical reference
  ADDED_FUND_TO_ORG = 'added.fund.to.org',
  COLLECTIVE_TRANSACTION_PAID = 'collective.transaction.paid', // replaced with COLLECTIVE_EXPENSE_PAID
  COLLECTIVE_USER_ADDED = 'collective.user.added',
  COLLECTIVE_VIRTUAL_CARD_ASSIGNED = 'collective.virtualcard.assigned', // replaced with COLLECTIVE_VIRTUAL_CARD_ADDED
  COLLECTIVE_VIRTUAL_CARD_CREATED = 'collective.virtualcard.created', // replaced with COLLECTIVE_VIRTUAL_CARD_ADDED
  SUBSCRIPTION_CONFIRMED = 'subscription.confirmed',
  COLLECTIVE_COMMENT_CREATED = 'collective.comment.created',
  ORDER_PENDING_CRYPTO = 'order.pending.crypto',
  BACKYOURSTACK_DISPATCH_CONFIRMED = 'backyourstack.dispatch.confirmed',
  ORDER_THANKYOU = 'order.thankyou', // renamed to ORDER_CONFIRMED
}

/** This array defines the type of activities that are transactional and can not be unsubscribed by the user. */
export const TransactionalActivities = [
  ActivityTypes.USER_NEW_TOKEN,
  ActivityTypes.USER_CHANGE_EMAIL,
  ActivityTypes.ORDER_PENDING,
  ActivityTypes.ORDER_PENDING_CRYPTO,
  ActivityTypes.ORDER_CONFIRMED,
  ActivityTypes.PAYMENT_CREDITCARD_EXPIRING,
  ActivityTypes.PAYMENT_CREDITCARD_CONFIRMATION,
  ActivityTypes.PAYMENT_FAILED,
  ActivityTypes.TAXFORM_REQUEST,
  ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
  ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
  ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED,
  ActivityTypes.HOST_APPLICATION_CONTACT,
  ActivityTypes.OAUTH_APPLICATION_AUTHORIZED,
];

export enum ActivityClasses {
  COLLECTIVE = 'collectives',
  EXPENSES = 'expenses',
  CONTRIBUTIONS = 'contributions',
  ACTIVITIES_UPDATES = 'activitiesUpdates',
  VIRTUAL_CARDS = 'virtualCards',
  FUND_EVENTS = 'fundsEvents',
  REPORTS = 'reports',
}

export const ActivitiesPerClass: Record<ActivityClasses, ActivityTypes[]> = {
  [ActivityClasses.COLLECTIVE]: [
    ActivityTypes.COLLECTIVE_APPLY,
    ActivityTypes.COLLECTIVE_APPROVED,
    ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITED,
    ActivityTypes.COLLECTIVE_CORE_MEMBER_INVITATION_DECLINED,
    ActivityTypes.COLLECTIVE_CORE_MEMBER_ADDED,
    ActivityTypes.COLLECTIVE_CORE_MEMBER_EDITED,
    ActivityTypes.COLLECTIVE_CORE_MEMBER_REMOVED,
    ActivityTypes.COLLECTIVE_MEMBER_INVITED,
    ActivityTypes.COLLECTIVE_CREATED_GITHUB,
    ActivityTypes.COLLECTIVE_CREATED,
    ActivityTypes.COLLECTIVE_REJECTED,
    ActivityTypes.COLLECTIVE_FROZEN,
    ActivityTypes.COLLECTIVE_UNFROZEN,
    ActivityTypes.COLLECTIVE_UNHOSTED,
    ActivityTypes.ORGANIZATION_COLLECTIVE_CREATED,
    ActivityTypes.DEACTIVATED_COLLECTIVE_AS_HOST,
    ActivityTypes.ACTIVATED_COLLECTIVE_AS_HOST,
    ActivityTypes.ACTIVATED_COLLECTIVE_AS_INDEPENDENT,
    ActivityTypes.COLLECTIVE_TRANSACTION_CREATED, // TODO: Should not be here. See https://github.com/opencollective/opencollective/issues/5903
    ActivityTypes.COLLECTIVE_EDITED,
    ActivityTypes.COLLECTIVE_DELETED,
  ],
  [ActivityClasses.EXPENSES]: [
    ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
    ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
    ActivityTypes.COLLECTIVE_EXPENSE_DELETED,
    ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
    ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
    ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
    ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_SPAM,
    ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
    ActivityTypes.COLLECTIVE_EXPENSE_MISSING_RECEIPT,
    ActivityTypes.COLLECTIVE_EXPENSE_PAID,
    ActivityTypes.COLLECTIVE_EXPENSE_PROCESSING,
    ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED,
    ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
    ActivityTypes.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
    ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
    ActivityTypes.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
    ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
    ActivityTypes.EXPENSE_COMMENT_CREATED,
    ActivityTypes.TAXFORM_REQUEST,
  ],
  [ActivityClasses.CONTRIBUTIONS]: [
    ActivityTypes.COLLECTIVE_MEMBER_CREATED,
    ActivityTypes.CONTRIBUTION_REJECTED,
    ActivityTypes.ORDER_PAYMENT_FAILED,
    ActivityTypes.ORDER_PENDING_CONTRIBUTION_NEW,
    ActivityTypes.ORDER_PENDING_CONTRIBUTION_REMINDER,
    ActivityTypes.ORDER_PENDING_CRYPTO,
    ActivityTypes.ORDER_PENDING,
    ActivityTypes.ORDER_PROCESSING,
    ActivityTypes.ORDER_CONFIRMED,
    ActivityTypes.ORDERS_SUSPICIOUS,
    ActivityTypes.PAYMENT_CREDITCARD_CONFIRMATION,
    ActivityTypes.PAYMENT_CREDITCARD_EXPIRING,
    ActivityTypes.PAYMENT_FAILED,
    ActivityTypes.SUBSCRIPTION_ACTIVATED,
    ActivityTypes.SUBSCRIPTION_CANCELED,
    ActivityTypes.SUBSCRIPTION_CONFIRMED,
  ],
  [ActivityClasses.ACTIVITIES_UPDATES]: [
    ActivityTypes.HOST_APPLICATION_CONTACT,
    ActivityTypes.COLLECTIVE_COMMENT_CREATED,
    ActivityTypes.COLLECTIVE_CONVERSATION_CREATED,
    ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
    ActivityTypes.COLLECTIVE_UPDATE_CREATED,
    ActivityTypes.CONVERSATION_COMMENT_CREATED,
    ActivityTypes.UPDATE_COMMENT_CREATED,
  ],
  [ActivityClasses.FUND_EVENTS]: [ActivityTypes.TICKET_CONFIRMED],
  [ActivityClasses.VIRTUAL_CARDS]: [
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ADDED,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_ASSIGNED,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_CREATED,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_DELETED,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED_DUE_TO_INACTIVITY,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_REQUEST_APPROVED,
    ActivityTypes.COLLECTIVE_VIRTUAL_CARD_REQUEST_REJECTED,
    ActivityTypes.VIRTUAL_CARD_CHARGE_DECLINED,
    ActivityTypes.VIRTUAL_CARD_REQUESTED,
    ActivityTypes.VIRTUAL_CARD_PURCHASE,
  ],
  [ActivityClasses.REPORTS]: [ActivityTypes.COLLECTIVE_MONTHLY_REPORT],
};

export default ActivityTypes;
