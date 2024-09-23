import config from 'config';
import moment from 'moment';

import { SupportedCurrency } from './currencies';

const isProdOrStaging = config.env === 'production' || config.env === 'staging';
const migrationDate = moment('2024-10-05T00:00:00Z');
function isMigrated() {
  return isProdOrStaging && moment().isAfter(migrationDate);
}

const PlatformConstants = {
  get PlatformCollectiveId() {
    if (isMigrated()) {
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
};
export default PlatformConstants;
