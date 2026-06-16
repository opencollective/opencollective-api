import { expect } from 'chai';
import { createSandbox } from 'sinon';

import activities from '../../../server/constants/activities';
import { CollectiveType } from '../../../server/constants/collectives';
import { notify } from '../../../server/lib/notifications/email';
import models, { Activity, sequelize } from '../../../server/models';
import { randStr } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('server/models/Activity', () => {
  const sandbox = createSandbox();

  before(async () => {
    await resetTestDB();
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('afterCreate hook', () => {
    it('defers notification dispatch until the transaction commits', async () => {
      const notifyCollectiveStub = sandbox.stub(notify, 'collective').resolves([]);

      await sequelize.transaction(async transaction => {
        const collective = models.Collective.build({
          type: CollectiveType.ORGANIZATION,
          name: randStr('Deferred Activity Org '),
          slug: randStr('deferred-activity-org-'),
          isActive: false,
        });
        await collective.save({ transaction });

        await Activity.create(
          {
            type: activities.ACTIVATED_MONEY_MANAGEMENT,
            CollectiveId: collective.id,
            FromCollectiveId: collective.id,
            data: { collective: collective.info },
          },
          { transaction },
        );

        expect(notifyCollectiveStub).to.not.have.been.called;
      });

      expect(notifyCollectiveStub).to.have.been.calledOnce;
    });

    it('does not dispatch notifications when the transaction rolls back', async () => {
      const notifyCollectiveStub = sandbox.stub(notify, 'collective').resolves([]);

      await expect(
        sequelize.transaction(async transaction => {
          const collective = models.Collective.build({
            type: CollectiveType.ORGANIZATION,
            name: randStr('Rolled Back Activity Org '),
            slug: randStr('rolled-back-activity-org-'),
            isActive: false,
          });
          await collective.save({ transaction });

          await Activity.create(
            {
              type: activities.ACTIVATED_MONEY_MANAGEMENT,
              CollectiveId: collective.id,
              FromCollectiveId: collective.id,
              data: { collective: collective.info },
            },
            { transaction },
          );

          throw new Error('rollback');
        }),
      ).to.be.rejected;

      expect(notifyCollectiveStub).to.not.have.been.called;
    });

    it('dispatches notifications immediately when not created in a transaction', async () => {
      const notifyCollectiveStub = sandbox.stub(notify, 'collective').resolves([]);

      const collective = models.Collective.build({
        type: CollectiveType.ORGANIZATION,
        name: randStr('Immediate Activity Org '),
        slug: randStr('immediate-activity-org-'),
        isActive: false,
      });
      await collective.save();

      await Activity.create({
        type: activities.ACTIVATED_MONEY_MANAGEMENT,
        CollectiveId: collective.id,
        FromCollectiveId: collective.id,
        data: { collective: collective.info },
      });

      expect(notifyCollectiveStub).to.have.been.calledOnce;
    });
  });
});
