/**
 * Constants for OAuth scopes
 *
 */

enum OAuthScopes {
  email = 'email',
  incognito = 'incognito',
  account = 'account',
  expenses = 'expenses',
  orders = 'orders',
  transactions = 'transactions',
  virtualCards = 'virtualCards',
  updates = 'updates',
  conversations = 'conversations',
  webhooks = 'webhooks',
  host = 'host',
  applications = 'applications',
  connectedAccounts = 'connectedAccounts',
  root = 'root',
}

// In many places we check the scope using a direct string. This type will ensure we still use values from the enum.
export type OAuthScope = keyof typeof OAuthScopes;

export default OAuthScopes;
