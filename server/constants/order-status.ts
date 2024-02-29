/*
 * Constants for the order status
 *
 * pending -> paid (one-time)
 * pending -> active (subscription)
 * pending -> active -> cancelled (subscription)
 * pending -> cancelled
 * pending -> expired
 */

enum OrderStatuses {
  NEW = 'NEW', // New default state since August 2020
  REQUIRE_CLIENT_CONFIRMATION = 'REQUIRE_CLIENT_CONFIRMATION', // For Strong Customer Authentication ("3D Secure")
  PAID = 'PAID', // For One Time Contributions
  ERROR = 'ERROR', // For One Time and Recurring Contribution
  PROCESSING = 'PROCESSING', // For Stripe Payment Intent based Orders
  REJECTED = 'REJECTED', // When a collective/host admin rejects a contribution
  // This is only for "Recurring Contributions"
  ACTIVE = 'ACTIVE', // Active Recurring contribution with up to date payments
  CANCELLED = 'CANCELLED', // When it's Cancelled by contributors or automatically after X failures
  // This is only for "Manual" payments
  PENDING = 'PENDING', // Initial state
  EXPIRED = 'EXPIRED', // When it's marked as such by Admins
  // Disputed charges from Stripe
  DISPUTED = 'DISPUTED',
  REFUNDED = 'REFUNDED',
  PAUSED = 'PAUSED',
  // In review charges from Stripe,
  IN_REVIEW = 'IN_REVIEW',
}

export default OrderStatuses;
