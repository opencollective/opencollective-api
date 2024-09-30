import config from 'config';
import moment from 'moment';

import { SupportedCurrency } from './currencies';

const isProdOrStaging = config.env === 'production' || config.env === 'staging';
const MIGRATION_DATE = moment('2024-10-01T00:00:00Z');

/**
 * Returns the platform constants based on a function to check if the platform has been migrated.
 */
const getPlatformConstants = (checkIfMigrated: () => boolean) => ({
  get PlatformCollectiveId() {
    if (checkIfMigrated()) {
      // ofico
      return 835523;
    }
    // opencollective
    return 8686;
  },

  get PlatformUserId() {
    // Pia's account
    return 30;
  },

  get PlatformCurrency(): SupportedCurrency {
    return 'USD';
  },

  get PlatformBankAccountId() {
    return 2955;
  },

  get PlatformPayPalId() {
    return 6087;
  },

  get PlatformDefaultPaymentMethodId() {
    return 2955;
  },

  get PlatformAddress() {
    return '340 S Lemon Ave #3717, Walnut, CA 91789';
  },

  get PlatformCountry() {
    return 'US';
  },

  /** Gets all platform collective ids - old and new */
  get AllPlatformCollectiveIds() {
    return [8686, 835523];
  },
});

function isMigrated(date: moment.Moment) {
  return isProdOrStaging && date.isAfter(MIGRATION_DATE);
}

// ts-unused-exports:disable-next-line
export const getPlatformConstantsForDate = (date: Date | moment.Moment) => {
  return getPlatformConstants(() => isMigrated(moment(date)));
};

const PlatformConstants = getPlatformConstants(() => isMigrated(moment()));

// ts-unused-exports:disable-next-line
export default PlatformConstants;
