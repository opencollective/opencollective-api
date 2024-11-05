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
    // https://opencollective.com/opencollective
    return 8686;
  },

  get OfitechCollectiveId() {
    // https://opencollective.com/ofitech
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
    // https://opencollective.com/ofitech-admin
    return 741159;
  },

  get PlatformCurrency(): SupportedCurrency {
    return 'USD';
  },

  get PlatformBankAccountId() {
    // Ofitech bank account
    return 70674;
  },

  // Not supported for now
  // get PlatformPayPalId() {
  //   return 6087;
  // },

  get PlatformDefaultPaymentMethodId() {
    return this.PlatformBankAccountId;
  },

  get PlatformAddress() {
    return '440 N Barranca Ave #3489, Covina, CA 91723';
  },

  get PlatformCountry() {
    return 'US';
  },

  get PlatformName() {
    return 'Open Collective';
  },

  /** Gets all platform collective ids - old and new */
  get AllPlatformCollectiveIds() {
    return [8686, 835523];
  },

  get FirstPartyHostCollectiveIds() {
    return [
      11004, // opensource
      9807, // europe
      729588, // oce-foundation-eur
      696998, // oce-foundation-usd
    ];
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
