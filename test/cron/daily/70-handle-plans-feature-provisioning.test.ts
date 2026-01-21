import { expect } from 'chai';
import moment from 'moment';
import sinon from 'sinon';

import { runPlansFeatureProvisioningCron } from '../../../cron/daily/70-handle-plans-feature-provisioning';
import FEATURE from '../../../server/constants/feature';
import { PlatformSubscriptionTiers } from '../../../server/constants/plans';
import * as SentryLib from '../../../server/lib/sentry';
import models from '../../../server/models';
import { fakeActiveHost, fakePlatformSubscription, fakeRequiredLegalDocument } from '../../test-helpers/fake-data';
import { stubExport } from '../../test-helpers/stub-helper';
import { resetTestDB } from '../../utils';

describe('cron/daily/70-handle-plans-feature-provisioning', () => {
  let sandbox, provisionFeatureChangesSpy, reportErrorToSentryStub;

  beforeEach(async () => {
    await resetTestDB();
    sandbox = sinon.createSandbox();
    provisionFeatureChangesSpy = sandbox.spy(models.PlatformSubscription, 'provisionFeatureChanges');
    reportErrorToSentryStub = stubExport(sandbox, SentryLib, 'reportErrorToSentry');
  });

  afterEach(() => {
    sandbox.restore();
  });

  describe('when a new subscription starts (with no previous subscription)', () => {
    it('should provision the features and update the status', async () => {
      const today = moment.utc().startOf('day').toDate();

      // Create a new subscription with PENDING status that starts today
      const subscription = await fakePlatformSubscription({
        featureProvisioningStatus: 'PENDING',
        period: [
          { value: today, inclusive: true },
          { value: Infinity, inclusive: true },
        ],
      });

      // Run the cron job
      const processedIds = await runPlansFeatureProvisioningCron();

      // Should have processed this subscription
      expect(processedIds).to.include(subscription.id);

      // Verify provisionFeatureChanges was called correctly
      expect(provisionFeatureChangesSpy.calledOnce).to.be.true;
      const call = provisionFeatureChangesSpy.getCall(0);
      expect(call.args[0].id).to.equal(subscription.CollectiveId); // collective
      expect(call.args[1]).to.be.null; // previousSubscription (none)
      expect(call.args[2].id).to.equal(subscription.id); // newSubscription

      // Reload and check status
      await subscription.reload();
      expect(subscription.featureProvisioningStatus).to.equal('PROVISIONED');
    });

    it('should not process subscriptions that start in the future', async () => {
      const tomorrow = moment.utc().add(1, 'day').startOf('day').toDate();

      // Create a subscription that starts tomorrow
      const subscription = await fakePlatformSubscription({
        period: [
          { value: tomorrow, inclusive: true },
          { value: Infinity, inclusive: true },
        ],
        featureProvisioningStatus: 'PENDING',
      });

      // Run the cron job
      const processedIds = await runPlansFeatureProvisioningCron();

      // Should not have processed this subscription
      expect(processedIds).to.not.include(subscription.id);

      // Verify provisionFeatureChanges was NOT called
      expect(provisionFeatureChangesSpy.called).to.be.false;

      // Status should still be pending
      await subscription.reload();
      expect(subscription.featureProvisioningStatus).to.equal('PENDING');
    });
  });

  describe('when a subscription is replaced', () => {
    it('should deprovision old features and provision new features', async () => {
      const today = moment.utc().startOf('day').toDate();

      // Create a previous subscription with TAX_FORMS feature (already provisioned)
      const previousSubscription = await fakePlatformSubscription({
        plan: {
          features: { [FEATURE.TAX_FORMS]: true },
        },
        period: [
          { value: moment.utc().subtract(30, 'days').startOf('day').toDate(), inclusive: true },
          { value: today, inclusive: false },
        ],
        featureProvisioningStatus: 'PROVISIONED',
      });

      // Create a legal document that should be removed
      const legalDoc = await fakeRequiredLegalDocument({
        HostCollectiveId: previousSubscription.CollectiveId,
      });

      // Create a new subscription without TAX_FORMS feature (PENDING status)
      const newSubscription = await fakePlatformSubscription({
        CollectiveId: previousSubscription.CollectiveId,
        plan: {
          features: { [FEATURE.TAX_FORMS]: false },
        },
        period: [
          { value: today, inclusive: true },
          { value: Infinity, inclusive: true },
        ],
        featureProvisioningStatus: 'PENDING',
      });

      // Run the cron job
      const processedIds = await runPlansFeatureProvisioningCron();

      // Should have processed the new subscription
      expect(processedIds).to.include(newSubscription.id);

      // Verify provisionFeatureChanges was called correctly
      expect(provisionFeatureChangesSpy.calledOnce).to.be.true;
      const call = provisionFeatureChangesSpy.getCall(0);
      expect(call.args[0].id).to.equal(previousSubscription.CollectiveId); // collective
      expect(call.args[1].id).to.equal(previousSubscription.id); // previousSubscription
      expect(call.args[2].id).to.equal(newSubscription.id); // newSubscription

      // Check that previous subscription is deprovisioned
      await previousSubscription.reload();
      expect(previousSubscription.featureProvisioningStatus).to.equal('DEPROVISIONED');

      // Check that new subscription is provisioned
      await newSubscription.reload();
      expect(newSubscription.featureProvisioningStatus).to.equal('PROVISIONED');

      // Check that legal document was removed
      const existingDoc = await models.RequiredLegalDocument.findByPk(legalDoc.id, { paranoid: false });
      expect(existingDoc.deletedAt).to.not.be.null;
    });
  });

  describe('when a subscription is cancelled without being replaced', () => {
    it('should deprovision the features and update the status', async () => {
      const yesterday = moment.utc().subtract(1, 'day').startOf('day').toDate();

      // Create a subscription that ended yesterday with TAX_FORMS feature
      const endedSubscription = await fakePlatformSubscription({
        plan: {
          features: { [FEATURE.TAX_FORMS]: true },
        },
        period: [
          { value: moment.utc().subtract(30, 'days').startOf('day').toDate(), inclusive: true },
          { value: yesterday, inclusive: true },
        ],
        featureProvisioningStatus: 'PROVISIONED',
      });

      // Create a legal document that should be removed
      const legalDoc = await fakeRequiredLegalDocument({
        HostCollectiveId: endedSubscription.CollectiveId,
      });

      // Run the cron job
      const processedIds = await runPlansFeatureProvisioningCron();

      // Should have processed this subscription
      expect(processedIds).to.include(endedSubscription.id);

      // Verify provisionFeatureChanges was called correctly
      expect(provisionFeatureChangesSpy.calledOnce).to.be.true;
      const call = provisionFeatureChangesSpy.getCall(0);
      expect(call.args[0].id).to.equal(endedSubscription.CollectiveId); // collective
      expect(call.args[1].id).to.equal(endedSubscription.id); // previousSubscription (ending)
      expect(call.args[2]).to.be.null; // newSubscription (none - cancelled)

      // Check that subscription is deprovisioned
      await endedSubscription.reload();
      expect(endedSubscription.featureProvisioningStatus).to.equal('DEPROVISIONED');

      // Check that legal document was removed
      const existingDoc = await models.RequiredLegalDocument.findByPk(legalDoc.id, { paranoid: false });
      expect(existingDoc.deletedAt).to.not.be.null;
    });

    it('should not deprovision if there is a replacement subscription', async () => {
      const host = await fakeActiveHost();
      const today = moment.utc().startOf('day').toDate();

      // Previous subscription that ended
      const endedSubscription = await models.PlatformSubscription.create({
        CollectiveId: host.id,
        plan: {
          features: { [FEATURE.TAX_FORMS]: true },
        },
        period: [
          { value: moment.utc().subtract(30, 'days').startOf('day').toDate(), inclusive: true },
          { value: today, inclusive: false },
        ],
        featureProvisioningStatus: 'PROVISIONED',
      });

      // New current subscription (already provisioned)
      await models.PlatformSubscription.create({
        CollectiveId: host.id,
        plan: {
          features: { [FEATURE.TAX_FORMS]: true },
        },
        period: [
          { value: today, inclusive: true },
          { value: Infinity, inclusive: true },
        ],
        featureProvisioningStatus: 'PROVISIONED',
      });

      // Run the cron job
      const processedIds = await runPlansFeatureProvisioningCron();

      // Should not have deprovisioned the ended subscription since there's a replacement
      expect(processedIds).to.not.include(endedSubscription.id);

      // Verify provisionFeatureChanges was NOT called for the ended subscription
      // (should not be called because there's a replacement subscription)
      expect(provisionFeatureChangesSpy.called).to.be.false;

      // Status should remain as PROVISIONED
      await endedSubscription.reload();
      expect(endedSubscription.featureProvisioningStatus).to.equal('PROVISIONED');
    });
  });

  describe('edge cases', () => {
    it('should return empty array when no subscriptions need provisioning', async () => {
      const processedIds = await runPlansFeatureProvisioningCron();
      expect(processedIds).to.deep.equal([]);
      expect(provisionFeatureChangesSpy.called).to.be.false;
    });

    it('should handle errors gracefully and continue processing other subscriptions', async () => {
      const today = moment.utc().startOf('day').toDate();

      // Create two subscriptions
      const subscription1 = await fakePlatformSubscription({
        plan: PlatformSubscriptionTiers[0],
        period: [
          { value: today, inclusive: true },
          { value: Infinity, inclusive: true },
        ],
        featureProvisioningStatus: 'PENDING',
      });

      const subscription2 = await fakePlatformSubscription({
        plan: PlatformSubscriptionTiers[0],
        period: [
          { value: today, inclusive: true },
          { value: Infinity, inclusive: true },
        ],
        featureProvisioningStatus: 'PENDING',
      });

      // Remove spy on provisionFeatureChanges
      provisionFeatureChangesSpy.restore();

      // Stub provisionFeatureChanges to throw an error ONLY for subscription 2
      sandbox.stub(models.PlatformSubscription, 'provisionFeatureChanges').callsFake(collective => {
        if (collective.id === subscription2.CollectiveId) {
          throw new Error('Test error');
        } else {
          return Promise.resolve();
        }
      });

      // Run the cron job
      const processedIds = await runPlansFeatureProvisioningCron();

      // Should have processed only the first subscription
      expect(processedIds).to.have.lengthOf(1);
      expect(processedIds).to.include(subscription1.id);

      // Make sure the error was reported to Sentry
      expect(reportErrorToSentryStub.calledOnce).to.be.true;
      expect(reportErrorToSentryStub.firstCall.args[0].message).to.equal('Test error');
    });
  });
});
