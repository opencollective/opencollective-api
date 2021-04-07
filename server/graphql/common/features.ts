
import FEATURE from '../../constants/feature';
import FEATURE_STATUS from '../../constants/feature-status';
import { hasFeature, isFeatureAllowedForCollectiveType } from '../../lib/allowed-features';
import models, { Op } from '../../models';

const checkIsActive = (
  promise: Promise<number | boolean>,
  fallback = FEATURE_STATUS.AVAILABLE,
): Promise<FEATURE_STATUS> => {
  return promise.then(result => (result ? FEATURE_STATUS.ACTIVE : fallback));
};


    return FEATURE_STATUS.UNSUPPORTED;
  } else if (!hasFeature(collective, feature)) {
    return FEATURE_STATUS.DISABLED;
  }

  // Add some special cases that check for data to see if the feature is `ACTIVE` or just `AVAILABLE`

    case FEATURE.UPDATES:
      return checkIsActive(
        models.Update.count({
          where: { CollectiveId: collective.id, publishedAt: { [Op.not]: null } },
          limit: 1,
        }),
      );
    case FEATURE.TRANSFERWISE:
      return checkIsActive(
        models.ConnectedAccount.count({
          where: { service: 'transferwise', CollectiveId: collective.id },
          limit: 1,
        }),
        FEATURE_STATUS.DISABLED,
      );
    default:
      return FEATURE_STATUS.ACTIVE;
  }
};
