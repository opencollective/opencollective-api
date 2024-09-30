import config from 'config';
import moment from 'moment';

import { SupportedCurrency } from './currencies';

const isProdOrStaging = config.env === 'production' || config.env === 'staging';

/**
 * Defines the transition date and time from OCI to Ofico.
 */
export const PLATFORM_MIGRATION_DATE = moment('2024-10-01T00:00:00Z');

/**
 * Returns the platform constants based on a function to check if the platform has been migrated.
 */
const getPlatformConstants = (checkIfMigrated: () => boolean) => ({
  get OCICollectiveId() {
    return 8686;
  },

  get OfitechCollectiveId() {
    return 845576;
  },

  get PlatformCollectiveId() {
    if (checkIfMigrated()) {
      return this.OfitechCollectiveId;
    } else {
      return this.OCICollectiveId;
    }
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

let __testingMigration = false;
export function __setIsTestingMigration(v: boolean) {
  __testingMigration = v;
}

function isMigrated(date: moment.Moment) {
  return (isProdOrStaging || __testingMigration) && date.isAfter(PLATFORM_MIGRATION_DATE);
}

export const getPlatformConstantsForDate = (date: Date | moment.Moment) => {
  return getPlatformConstants(() => isMigrated(moment(date)));
};

const PlatformConstants = getPlatformConstants(() => isMigrated(moment()));
export default PlatformConstants;
