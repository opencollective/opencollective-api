/**
 * Static privacy audit: introspects the GraphQL V2 schema and verifies that
 * every top-level query or field that can return an Account (or its concrete
 * types: Individual, Organization, Collective, Host, etc.) is registered in
 * an allow-list that declares how it enforces privacy.
 *
 * This test catches regressions: when a developer adds a new query that
 * returns an Account type, they are forced to explicitly register it here
 * with its privacy strategy.
 *
 * Privacy strategies:
 *  - 'entry-gate'  : the query/field itself calls assertCanSeeAccount before returning
 *  - 'parent-gate' : the parent query/field has an entry gate, so this nested field is protected
 *  - 'no-private'  : this field only returns accounts that cannot be private (e.g., USER type)
 *  - 'admin-only'  : the field requires admin role (e.g. connectedAccounts) which covers private
 *  - 'skipped'     : deliberately excluded from private-account concern (e.g. search, #8734)
 */

import { expect } from 'chai';
import { GraphQLInterfaceType, GraphQLObjectType, GraphQLSchema, isListType, isNonNullType } from 'graphql';

import schemaV2 from '../../server/graphql/v2/schema';

// ---------------------------------------------------------------------------
// Allow-list: maps `TypeName.fieldName` or a top-level `queryName` to a
// privacy strategy. New fields that return Account types MUST be added here.
// ---------------------------------------------------------------------------

const PRIVACY_STRATEGY: Record<string, string> = {
  // ---- Top-level queries ----
  'Query.account': 'entry-gate',
  'Query.individual': 'entry-gate',
  'Query.organization': 'entry-gate',
  'Query.collective': 'entry-gate',
  'Query.host': 'entry-gate',
  'Query.event': 'entry-gate',
  'Query.fund': 'entry-gate',
  'Query.project': 'entry-gate',
  'Query.accounts': 'entry-gate', // AccountsCollectionQuery filters out private accounts in WHERE clause
  'Query.transactions': 'entry-gate', // TransactionsCollectionResolver checks account privacy
  'Query.orders': 'entry-gate', // OrdersCollectionResolver checks account privacy
  'Query.expenses': 'entry-gate', // ExpensesCollectionQueryResolver checks account privacy
  'Query.search': 'skipped', // #8734: private account search exclusion is tracked separately
  'Query.update': 'entry-gate',
  'Query.conversation': 'entry-gate',
  'Query.expense': 'entry-gate', // assertExpenseAccessibleForPrivateCollective + expense permissions
  'Query.order': 'entry-gate', // assertOrderAccessibleForPrivateCollective
  'Query.tier': 'entry-gate',
  'Query.member': 'no-private',

  // ---- Account interface nested fields ----
  'Account.members': 'parent-gate',
  'Account.memberOf': 'parent-gate',
  'Account.transactions': 'parent-gate',
  'Account.transactionGroups': 'parent-gate',
  'Account.orders': 'parent-gate',
  'Account.expenses': 'parent-gate',
  'Account.updates': 'parent-gate', // has own canSeePrivateAccount check
  'Account.conversations': 'parent-gate', // has own canSeePrivateAccount check
  'Account.conversationsTags': 'parent-gate', // has own canSeePrivateAccount check
  'Account.expensesTags': 'parent-gate', // has own canSeePrivateAccount check
  'Account.connectedAccounts': 'admin-only',
  'Account.payoutMethods': 'admin-only',
  'Account.paymentMethods': 'admin-only',
  'Account.virtualCards': 'admin-only',
  'Account.childrenAccounts': 'parent-gate',
  'Account.features': 'parent-gate',
  'Account.policies': 'parent-gate',
  'Account.activitySubscriptions': 'admin-only',
  'Account.feed': 'admin-only',
  'Account.hostApplicationRequests': 'admin-only',
  'Account.webhooks': 'admin-only',
  'Account.emails': 'admin-only',
  'Account.permissions': 'parent-gate',
  'Account.stats': 'parent-gate',

  // ---- Host type nested fields ----
  'Host.hostedAccounts': 'parent-gate', // Host itself is gated at entry; hostedAccounts inherits

  // ---- Query.me ----
  'Query.me': 'no-private', // Returns the authenticated user, always accessible if logged in

  // ---- Fund nested fields ----
  'Fund.parentAccount': 'parent-gate',
  'Fund.duplicatedFromAccount': 'parent-gate',
  'Fund.host': 'parent-gate',
  'Fund.mainProfile': 'parent-gate',

  // ---- Project nested fields ----
  'Project.parentAccount': 'parent-gate',
  'Project.duplicatedFromAccount': 'parent-gate',
  'Project.host': 'parent-gate',
  'Project.parent': 'parent-gate',
  'Project.mainProfile': 'parent-gate',

  // ---- HostCollection ----
  'HostCollection.nodes': 'parent-gate', // Nodes in a Host collection are shown per-context

  // ---- ExportRequest nested fields ----
  'ExportRequest.account': 'admin-only',
  'ExportRequest.createdBy': 'admin-only',

  // ---- Response types from mutations - mutations are not in scope for entry-gate ----
  'AddTwoFactorAuthTokenToIndividualResponse.account': 'no-private',
  'ConfirmGuestAccountResponse.account': 'no-private',
  'ProcessHostApplicationResponse.account': 'no-private',
  'SetPasswordResponse.individual': 'no-private',
  'IndividualConfirmEmailResponse.individual': 'no-private',
  'FollowAccountResult.individual': 'no-private',
  'UnfollowAccountResult.individual': 'no-private',
  'MergeAccountsResponse.account': 'admin-only',
  'BanAccountResponse.accounts': 'admin-only',
  'TransactionsImportEditResponse.host': 'admin-only',

  // ---- Mutations that return Account types - mutations are out of scope for the read-path audit ----
  'Mutation.createCollective': 'skipped',
  'Mutation.createIncognitoProfile': 'skipped',
  'Mutation.createEvent': 'skipped',
  'Mutation.createFund': 'skipped',
  'Mutation.createProject': 'skipped',
  'Mutation.duplicateAccount': 'skipped',
  'Mutation.editAccountSetting': 'skipped',
  'Mutation.editAccountFeeStructure': 'skipped',
  'Mutation.editAccountFreezeStatus': 'skipped',
  'Mutation.removeTwoFactorAuthTokenFromIndividual': 'skipped',
  'Mutation.editTwoFactorAuthenticationMethod': 'skipped',
  'Mutation.editAccount': 'skipped',
  'Mutation.setPolicies': 'skipped',
  'Mutation.deleteAccount': 'skipped',
  'Mutation.convertAccountToOrganization': 'skipped',
  'Mutation.editAccountingCategories': 'skipped',
  'Mutation.updateContributionAccountingCategoryRules': 'skipped',
  'Mutation.applyToHost': 'skipped',
  'Mutation.removeHost': 'skipped',
  'Mutation.setChangelogViewDate': 'skipped',
  'Mutation.setNewsletterOptIn': 'skipped',
  'Mutation.startResumeOrdersProcess': 'skipped',
  'Mutation.createOrganization': 'skipped',
  'Mutation.editOrganizationMoneyManagementAndHosting': 'skipped',
  'Mutation.convertOrganizationToCollective': 'skipped',
  'Mutation.editAccountFlags': 'skipped',
  'Mutation.editAccountType': 'skipped',
  'Mutation.clearCacheForAccount': 'skipped',
  'Mutation.rootAnonymizeAccount': 'skipped',
  'Mutation.createVendor': 'skipped',
  'Mutation.editVendor': 'skipped',
  'Mutation.convertOrganizationToVendor': 'skipped',
  'Mutation.updateAccountPlatformSubscription': 'skipped',

  // ---- Query.loggedInAccount ----
  'Query.loggedInAccount': 'no-private', // Returns the authenticated user

  // ---- Debit transaction nested fields ----
  'Debit.host': 'parent-gate',
  'Debit.account': 'parent-gate',
  'Debit.oppositeAccount': 'parent-gate',
  'Debit.fromAccount': 'parent-gate',
  'Debit.toAccount': 'parent-gate',
  'Debit.giftCardEmitterAccount': 'parent-gate',

  // ---- Event nested fields ----
  'Event.parentAccount': 'parent-gate',
  'Event.duplicatedFromAccount': 'parent-gate',
  'Event.host': 'parent-gate',
  'Event.parent': 'parent-gate',
  'Event.mainProfile': 'parent-gate',

  // ---- AccountWithParent ----
  'AccountWithParent.parent': 'parent-gate',

  // ---- Individual nested fields ----
  'Individual.parentAccount': 'parent-gate',
  'Individual.duplicatedFromAccount': 'parent-gate',
  'Individual.host': 'parent-gate',
  'Individual.mainProfile': 'parent-gate',

  // ---- PersonalToken ----
  'PersonalToken.account': 'admin-only',

  // ---- Contributor/Member nested fields ----
  'ContributorProfile.account': 'parent-gate',
  'ContributorProfile.forAccount': 'parent-gate',
  'Member.account': 'parent-gate',
  'MemberOf.account': 'parent-gate',

  // ---- Organization nested fields ----
  'Organization.parentAccount': 'parent-gate',
  'Organization.duplicatedFromAccount': 'parent-gate',
  'Organization.host': 'parent-gate',
  'Organization.mainProfile': 'parent-gate',

  // ---- Vendor nested fields ----
  'Vendor.parentAccount': 'parent-gate',
  'Vendor.duplicatedFromAccount': 'parent-gate',
  'Vendor.createdByAccount': 'parent-gate',
  'Vendor.visibleToAccounts': 'admin-only',
  'Vendor.mainProfile': 'parent-gate',

  // ---- VirtualCard nested fields ----
  'VirtualCard.account': 'admin-only',
  'VirtualCard.host': 'admin-only',
  'VirtualCard.assignee': 'admin-only',

  // ---- VirtualCardRequest nested fields ----
  'VirtualCardRequest.assignee': 'admin-only',
  'VirtualCardRequest.host': 'admin-only',
  'VirtualCardRequest.account': 'admin-only',

  // ---- Credit transaction nested fields (parallel to Debit) ----
  'Credit.host': 'parent-gate',
  'Credit.account': 'parent-gate',
  'Credit.oppositeAccount': 'parent-gate',
  'Credit.fromAccount': 'parent-gate',
  'Credit.toAccount': 'parent-gate',
  'Credit.giftCardEmitterAccount': 'parent-gate',

  // ---- PaymentMethod ----
  'PaymentMethod.account': 'admin-only',
  'PaymentMethod.limitedToHosts': 'admin-only',

  // ---- ConnectedAccount ----
  'ConnectedAccount.accountsMirrored': 'admin-only',
  'ConnectedAccount.createdByAccount': 'admin-only',

  // ---- ActivitySubscription ----
  'ActivitySubscription.account': 'admin-only',
  'ActivitySubscription.individual': 'admin-only',

  // ---- Activity ----
  'Activity.fromAccount': 'parent-gate',
  'Activity.account': 'parent-gate',
  'Activity.host': 'parent-gate',
  'Activity.individual': 'parent-gate',

  // ---- TransactionGroup ----
  'TransactionGroup.host': 'parent-gate',
  'TransactionGroup.account': 'parent-gate',

  // ---- CommunityAssociatedAccount ----
  'CommunityAssociatedAccount.account': 'parent-gate',

  // ---- KYCVerification ----
  'KYCVerification.requestedByAccount': 'admin-only',
  'KYCVerification.account': 'admin-only',
  'KYCVerification.createdByUser': 'admin-only',

  // ---- Webhook ----
  'Webhook.account': 'admin-only',

  // ---- Agreement ----
  'Agreement.createdBy': 'admin-only',
  'Agreement.account': 'admin-only',
  'Agreement.host': 'admin-only',

  // ---- Collection node types ----
  'HostedAccountCollection.nodes': 'parent-gate',
  'VendorCollection.nodes': 'parent-gate',

  // ---- TransactionsImport ----
  'TransactionsImport.account': 'admin-only',
  'TransactionsImportAssignment.accounts': 'admin-only',
  'TransactionsImportRow.assignedAccounts': 'admin-only',

  // ---- RecurringExpense ----
  'RecurringExpense.account': 'parent-gate',
  'RecurringExpense.fromAccount': 'parent-gate',

  // ---- Bot nested fields ----
  'Bot.parentAccount': 'parent-gate',
  'Bot.duplicatedFromAccount': 'parent-gate',
  'Bot.mainProfile': 'parent-gate',

  // ---- Collective nested fields ----
  'Collective.parentAccount': 'parent-gate',
  'Collective.duplicatedFromAccount': 'parent-gate',
  'Collective.host': 'parent-gate',
  'Collective.mainProfile': 'parent-gate',

  // ---- AccountWithHost ----
  'AccountWithHost.host': 'parent-gate',

  // ---- MemberInvitation ----
  'MemberInvitation.inviter': 'admin-only',
  'MemberInvitation.account': 'admin-only',
  'MemberInvitation.memberAccount': 'admin-only',

  // ---- Order ----
  'Order.fromAccount': 'parent-gate',
  'Order.toAccount': 'parent-gate',
  'Order.createdByAccount': 'parent-gate',

  // ---- Transaction interface ----
  'Transaction.host': 'parent-gate',
  'Transaction.account': 'parent-gate',
  'Transaction.oppositeAccount': 'parent-gate',
  'Transaction.fromAccount': 'parent-gate',
  'Transaction.toAccount': 'parent-gate',
  'Transaction.giftCardEmitterAccount': 'parent-gate',

  // ---- Expense ----
  'Expense.approvedBy': 'admin-only',
  'Expense.paidBy': 'admin-only',
  'Expense.account': 'parent-gate',
  'Expense.payee': 'parent-gate',
  'Expense.createdByAccount': 'parent-gate',
  'Expense.host': 'parent-gate',
  'Expense.requestedByAccount': 'admin-only',

  // ---- AccountingCategory ----
  'AccountingCategory.account': 'admin-only',

  // ---- Host nested fields ----
  'Host.parentAccount': 'parent-gate',
  'Host.duplicatedFromAccount': 'parent-gate',
  'Host.mainProfile': 'parent-gate',

  // ---- Contributor ----
  'Contributor.account': 'parent-gate',

  // ---- AccountCollection ----
  'AccountCollection.nodes': 'parent-gate',

  // ---- LegalDocument ----
  'LegalDocument.account': 'admin-only',

  // ---- Conversation ----
  'Conversation.account': 'parent-gate',
  'Conversation.fromAccount': 'parent-gate',

  // ---- Comment ----
  'Comment.fromAccount': 'parent-gate',
  'Comment.account': 'parent-gate',

  // ---- HostApplication ----
  'HostApplication.account': 'admin-only',
  'HostApplication.host': 'admin-only',

  // ---- Update ----
  'Update.fromAccount': 'parent-gate',
  'Update.account': 'parent-gate',

  // ---- Application / OAuth ----
  'Application.account': 'admin-only',
  'OAuthAuthorization.account': 'admin-only',

  // ---- Account interface base fields ----
  'Account.parentAccount': 'parent-gate',
  'Account.duplicatedFromAccount': 'parent-gate',
  'Account.mainProfile': 'parent-gate',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the type name is an Account-like type we care about. */
function isAccountLike(typeName: string): boolean {
  return [
    'Account',
    'Individual',
    'Organization',
    'Collective',
    'Host',
    'Event',
    'Fund',
    'Project',
    'Bot',
    'Vendor',
  ].includes(typeName);
}

function getNamedTypeName(type: any): string {
  if (isNonNullType(type) || isListType(type)) {
    return getNamedTypeName(type.ofType);
  }
  return type.name;
}

/** Enumerate all query/field pairs in a schema that return account-like types. */
function collectAccountFields(schema: GraphQLSchema): Array<{ owner: string; field: string }> {
  const results: Array<{ owner: string; field: string }> = [];

  const process = (typeName: string, fields: Record<string, any>) => {
    for (const [fieldName, field] of Object.entries(fields)) {
      const returnTypeName = getNamedTypeName(field.type);
      if (isAccountLike(returnTypeName)) {
        results.push({ owner: typeName, field: fieldName });
      }
    }
  };

  // Query root
  const queryType = schema.getQueryType();
  if (queryType) {
    process('Query', queryType.getFields());
  }

  // All types
  for (const type of Object.values(schema.getTypeMap())) {
    if (type instanceof GraphQLObjectType || type instanceof GraphQLInterfaceType) {
      if (type.name.startsWith('__')) {
        continue;
      }
      process(type.name, type.getFields());
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('server/graphql/v2/privacy-audit', () => {
  it('all Account-returning fields are registered in the privacy allow-list', () => {
    const accountFields = collectAccountFields(schemaV2 as unknown as GraphQLSchema);
    const unregistered: string[] = [];

    for (const { owner, field } of accountFields) {
      const key = `${owner}.${field}`;
      if (!(key in PRIVACY_STRATEGY)) {
        unregistered.push(key);
      }
    }

    if (unregistered.length > 0) {
      throw new Error(
        `The following Account-returning fields are not registered in the privacy allow-list:\n${unregistered
          .map(k => `  - ${k}`)
          .join('\n')}\n\nPlease add them to the PRIVACY_STRATEGY map in privacy-audit.test.ts ` +
          `with the appropriate privacy strategy ('entry-gate', 'parent-gate', 'no-private', 'admin-only', or 'skipped').`,
      );
    }

    // Sanity: at least some fields are present
    expect(accountFields.length).to.be.greaterThan(0);
  });

  it('all registered strategies are valid', () => {
    const validStrategies = new Set(['entry-gate', 'parent-gate', 'no-private', 'admin-only', 'skipped']);
    for (const [key, strategy] of Object.entries(PRIVACY_STRATEGY)) {
      expect(validStrategies.has(strategy), `Invalid strategy '${strategy}' for '${key}'`).to.be.true;
    }
  });
});
