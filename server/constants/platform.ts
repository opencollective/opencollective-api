import config from 'config';
import { uniq } from 'lodash';

import { SupportedCurrency } from './currencies';

/**
 * Returns the platform constants based on a function to check if the platform has been migrated.
 */
const getPlatformConstants = () => ({
  get OCICollectiveId() {
    // https://opencollective.com/opencollective
    // used to be the default platform account before 2024-10-01
    return 8686;
  },

  get OfitechCollectiveId() {
    // https://opencollective.com/ofitech
    return 845576;
  },

  get OficoCollectiveId() {
    // https://opencollective.com/ofico
    return 835523;
  },

  get PlatformCollectiveId() {
    return parseInt(config.platform.collectiveId) || this.OfitechCollectiveId;
  },

  get PlatformUserId() {
    // https://opencollective.com/ofitech-admin
    return parseInt(config.platform.userId) || 741159;
  },

  get PlatformCurrency(): SupportedCurrency {
    return config.platform.currency || 'USD';
  },

  get PlatformAddress() {
    return config.platform.address || '440 N Barranca Ave #3489, Covina, CA 91723';
  },

  get PlatformCountry() {
    return config.platform.country || 'US';
  },

  get PlatformName() {
    return config.platform.name || 'Open Collective';
  },

  /** Gets all platform collective ids - old and new */
  get AllPlatformCollectiveIds() {
    return uniq(
      [
        parseInt(config.platform.collectiveId),
        this.OCICollectiveId,
        this.OfitechCollectiveId,
        this.OficoCollectiveId,
      ].filter(Boolean),
    );
  },

  get CurrentPlatformCollectiveIds() {
    return uniq(
      [parseInt(config.platform.collectiveId), this.OfitechCollectiveId, this.OficoCollectiveId].filter(Boolean),
    );
  },

  get FiscalHostOSCCollectiveId() {
    return 11004;
  },

  get FirstPartyHostCollectiveIds() {
    return [
      this.FiscalHostOSCCollectiveId,
      9807, // europe
      729588, // oce-foundation-eur
      696998, // oce-foundation-usd
      766450, // raft
      206897, // metagov
    ];
  },
});

const PlatformConstants = getPlatformConstants();
export default PlatformConstants;
