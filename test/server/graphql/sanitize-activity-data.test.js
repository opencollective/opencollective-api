import { expect } from 'chai';

import ActivityTypes from '../../../server/constants/activities';
import { sanitizeActivityData } from '../../../server/graphql/common/activities';

describe('server/graphql/common/activities', () => {
  describe('sanitizeActivityData', () => {
    it('strips data from COLLECTIVE_EDITED previousData and newData', async () => {
      const req = {
        remoteUser: { isAdminOfCollectiveOrHost: () => true },
        loaders: {
          Collective: {
            byId: { load: async () => ({ id: 1 }) },
          },
        },
      };

      const activity = {
        type: ActivityTypes.COLLECTIVE_EDITED,
        CollectiveId: 1,
        data: {
          previousData: { tags: ['old'], data: { privateInstructions: 'secret' } },
          newData: { tags: ['new'], data: { privateInstructions: 'secret2' } },
        },
      };

      const result = await sanitizeActivityData(req, activity);

      expect(result.previousData).to.deep.eq({ tags: ['old'] });
      expect(result.newData).to.deep.eq({ tags: ['new'] });
    });
  });
});
