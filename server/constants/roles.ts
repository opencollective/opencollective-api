enum MemberRoles {
  /** Holds money on behalf of the collective */
  HOST = 'HOST',
  /** Can approve expenses */
  ADMIN = 'ADMIN',
  /** Member of the collective but cannot approve expenses */
  MEMBER = 'MEMBER',
  /** Occasional contributor (giving time) */
  CONTRIBUTOR = 'CONTRIBUTOR',
  /** Supporter giving money */
  BACKER = 'BACKER',
  /** Someone who registered for a free tier (typically a free event ticket) */
  ATTENDEE = 'ATTENDEE',
  /** Someone interested to follow the activities of the collective/event */
  FOLLOWER = 'FOLLOWER',
  /** This memberCollective is a connected-collective of the collective */
  CONNECTED_COLLECTIVE = 'CONNECTED_COLLECTIVE',
  /** Has read access to all financial information and receipts/invoices */
  ACCOUNTANT = 'ACCOUNTANT',
}

export const MemberRoleLabels = {
  [MemberRoles.HOST]: 'Host',
  [MemberRoles.ADMIN]: 'Administrator',
  [MemberRoles.MEMBER]: 'Core Contributor',
  [MemberRoles.CONTRIBUTOR]: 'Contributor',
  [MemberRoles.BACKER]: 'Financial Contributor',
  [MemberRoles.ATTENDEE]: 'Attendee',
  [MemberRoles.FOLLOWER]: 'Follower',
  [MemberRoles.CONNECTED_COLLECTIVE]: 'Connected-collective',
  [MemberRoles.ACCOUNTANT]: 'Accountant',
};

export default MemberRoles;
