import { expect } from 'chai';
import { createSandbox } from 'sinon';

import activities from '../../../server/constants/activities';
import { CollectiveType } from '../../../server/constants/collectives';
import {
  disableActivityDispatchTracking,
  enableActivityDispatchTracking,
} from '../../../server/lib/notifications/activity-dispatch-tracker';
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

  describe('waitAllDispatch', () => {
    afterEach(() => {
      disableActivityDispatchTracking();
    });

    it('is a no-op when dispatch tracking is disabled', async () => {
      let dispatchCompleted = false;
      sandbox.stub(notify, 'collective').callsFake(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        dispatchCompleted = true;
        return [];
      });

      const collective = models.Collective.build({
        type: CollectiveType.ORGANIZATION,
        name: randStr('No Track Activity Org '),
        slug: randStr('no-track-activity-org-'),
        isActive: false,
      });
      await collective.save();

      await Activity.create({
        type: activities.ACTIVATED_MONEY_MANAGEMENT,
        CollectiveId: collective.id,
        FromCollectiveId: collective.id,
        data: { collective: collective.info },
      });

      await Activity.waitAllDispatch();
      expect(dispatchCompleted).to.be.false;
    });

    it('resolves immediately when nothing is pending', async () => {
      enableActivityDispatchTracking();
      await Activity.waitAllDispatch();
    });

    it('waits for immediate dispatches to complete', async () => {
      enableActivityDispatchTracking();
      let dispatchCompleted = false;
      sandbox.stub(notify, 'collective').callsFake(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        dispatchCompleted = true;
        return [];
      });

      const collective = models.Collective.build({
        type: CollectiveType.ORGANIZATION,
        name: randStr('Wait Activity Org '),
        slug: randStr('wait-activity-org-'),
        isActive: false,
      });
      await collective.save();

      await Activity.create({
        type: activities.ACTIVATED_MONEY_MANAGEMENT,
        CollectiveId: collective.id,
        FromCollectiveId: collective.id,
        data: { collective: collective.info },
      });

      expect(dispatchCompleted).to.be.false;
      await Activity.waitAllDispatch();
      expect(dispatchCompleted).to.be.true;
    });

    it('waits for transactional dispatches after commit', async () => {
      enableActivityDispatchTracking();
      let dispatchCompleted = false;
      sandbox.stub(notify, 'collective').callsFake(async () => {
        dispatchCompleted = true;
        return [];
      });

      await sequelize.transaction(async transaction => {
        const collective = models.Collective.build({
          type: CollectiveType.ORGANIZATION,
          name: randStr('Txn Wait Activity Org '),
          slug: randStr('txn-wait-activity-org-'),
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

        expect(dispatchCompleted).to.be.false;
        await Activity.waitAllDispatch();
        expect(dispatchCompleted).to.be.false;
      });

      await Activity.waitAllDispatch();
      expect(dispatchCompleted).to.be.true;
    });

    it('waits for all concurrent dispatches to complete', async () => {
      enableActivityDispatchTracking();
      let completedCount = 0;
      sandbox.stub(notify, 'collective').callsFake(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        completedCount++;
        return [];
      });

      const createActivity = async () => {
        const collective = models.Collective.build({
          type: CollectiveType.ORGANIZATION,
          name: randStr('Concurrent Activity Org '),
          slug: randStr('concurrent-activity-org-'),
          isActive: false,
        });
        await collective.save();
        await Activity.create({
          type: activities.ACTIVATED_MONEY_MANAGEMENT,
          CollectiveId: collective.id,
          FromCollectiveId: collective.id,
          data: { collective: collective.info },
        });
      };

      await Promise.all([createActivity(), createActivity(), createActivity()]);

      expect(completedCount).to.eq(0);
      await Activity.waitAllDispatch();
      expect(completedCount).to.eq(3);
    });
  });
});
