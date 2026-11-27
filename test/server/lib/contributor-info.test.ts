import { expect } from 'chai';

import { TransactionKind } from '../../../server/constants/transaction-kind';
import {
  findProfilesMissingInfo,
  getEffectiveContributorInfoThresholds,
  getYearlyContributedToHost,
  isExemptFromHostContributorInfo,
  isValidLegalName,
  locationHasAddress,
} from '../../../server/lib/contributor-info';
import { sequelize } from '../../../server/models';
import {
  fakeActiveHost,
  fakeCollective,
  fakeIncognitoProfile,
  fakeLocation,
  fakeOrganization,
  fakeTransaction,
  fakeUser,
} from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

const YEAR = 2025;
const inYear = (month = 5) => new Date(Date.UTC(YEAR, month, 15));

/** A contribution (credit) from `fromId` received by `host` through `collective` */
const contribute = (
  host: { id: number; currency: string },
  collective: { id: number },
  fromId: number,
  amount: number,
  overrides: Record<string, unknown> = {},
) =>
  fakeTransaction({
    type: 'CREDIT',
    kind: TransactionKind.CONTRIBUTION,
    CollectiveId: collective.id,
    FromCollectiveId: fromId,
    HostCollectiveId: host.id,
    amount,
    amountInHostCurrency: amount,
    currency: host.currency as 'USD',
    hostCurrency: host.currency as 'USD',
    createdAt: inYear(),
    ...overrides,
  });

const refreshCommunityViews = async () => {
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityTransactionSummary"');
  await sequelize.query('REFRESH MATERIALIZED VIEW "AdminCommunityHostYearlyTransactionSummary"');
};

describe('server/lib/contributor-info', () => {
  describe('getEffectiveContributorInfoThresholds', () => {
    it('applies the USD defaults to USD hosts without a stored policy', () => {
      expect(getEffectiveContributorInfoThresholds({ currency: 'USD', data: {} })).to.deep.equal({
        legalName: 250e2,
        address: 5000e2,
      });
    });

    it('has no thresholds for non-USD hosts without a stored policy', () => {
      expect(getEffectiveContributorInfoThresholds({ currency: 'EUR', data: {} })).to.deep.equal({});
    });

    it('uses the stored policy, where `{}`, `0` and `null` disable a field', () => {
      const withPolicy = thresholds => ({
        currency: 'USD' as const,
        data: { policies: { CONTRIBUTOR_INFO_THRESHOLDS: thresholds } },
      });
      expect(getEffectiveContributorInfoThresholds(withPolicy({}))).to.deep.equal({});
      expect(getEffectiveContributorInfoThresholds(withPolicy({ legalName: 0, address: null }))).to.deep.equal({});
      expect(getEffectiveContributorInfoThresholds(withPolicy({ legalName: 100e2 }))).to.deep.equal({
        legalName: 100e2,
      });
    });
  });

  describe('field rules', () => {
    it('locationHasAddress: formatted address or a non-blank structured value, never the country alone', () => {
      expect(locationHasAddress(null)).to.be.false;
      expect(locationHasAddress({ address: '  ', structured: {} })).to.be.false;
      expect(locationHasAddress({ address: null, structured: { address1: ' ', city: '' } })).to.be.false;
      expect(locationHasAddress({ address: '1 Main St' })).to.be.true;
      expect(locationHasAddress({ address: null, structured: { city: 'Paris' } })).to.be.true;
    });

    it('isValidLegalName: at least 5 characters, trimmed', () => {
      expect(isValidLegalName(null)).to.be.false;
      expect(isValidLegalName('  Bob  ')).to.be.false;
      expect(isValidLegalName('Wu Yi')).to.be.true;
      // Characters, not UTF-16 units: 4 characters, 5 units
      expect(isValidLegalName('𠮷田太郎')).to.be.false;
      expect(isValidLegalName('𠮷田太郎子')).to.be.true;
    });

    it('isExemptFromHostContributorInfo: the host itself and the accounts it hosts', () => {
      const host = { id: 1 };
      expect(isExemptFromHostContributorInfo({ id: 1, HostCollectiveId: null }, host)).to.be.true;
      expect(isExemptFromHostContributorInfo({ id: 2, HostCollectiveId: 1 }, host)).to.be.true;
      expect(isExemptFromHostContributorInfo({ id: 3, HostCollectiveId: 4 }, host)).to.be.false;
    });
  });

  describe('getYearlyContributedToHost', () => {
    let host, collective, user, incognito;

    before(async () => {
      await resetTestDB();
      host = await fakeActiveHost({ currency: 'USD' });
      collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });
      user = await fakeUser();
      incognito = await fakeIncognitoProfile(user);
      const otherHost = await fakeActiveHost({ currency: 'USD' });
      const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id });

      await contribute(host, collective, user.CollectiveId, 100e2);
      await contribute(host, collective, user.CollectiveId, 50e2, { kind: TransactionKind.ADDED_FUNDS });
      await contribute(host, collective, incognito.id, 30e2); // Folded into the user
      // Not counted
      const refunded = await contribute(host, collective, user.CollectiveId, 1000e2);
      await refunded.update({ RefundTransactionId: refunded.id });
      await contribute(host, collective, user.CollectiveId, 1000e2, { hostCurrency: 'EUR' }); // Former currency
      await contribute(host, collective, user.CollectiveId, 1000e2, {
        createdAt: new Date(Date.UTC(YEAR - 1, 11, 31, 23)),
      });
      await contribute(host, collective, user.CollectiveId, 1000e2, { createdAt: new Date(Date.UTC(YEAR + 1, 0, 1)) });
      await contribute(host, collective, user.CollectiveId, 1000e2, { kind: TransactionKind.PLATFORM_TIP });
      await contribute(otherHost, otherCollective, user.CollectiveId, 1000e2);
    });

    it('sums contributions and added funds of the UTC year in the current host currency, with incognito', async () => {
      const totals = await getYearlyContributedToHost({ hostId: host.id, profileIds: [user.CollectiveId], year: YEAR });
      expect(totals.get(user.CollectiveId)).to.eq(180e2);
    });

    it('returns nothing for profiles without contributions', async () => {
      const other = await fakeUser();
      const totals = await getYearlyContributedToHost({
        hostId: host.id,
        profileIds: [other.CollectiveId],
        year: YEAR,
      });
      expect(totals.has(other.CollectiveId)).to.be.false;
      expect((await getYearlyContributedToHost({ hostId: host.id, profileIds: [], year: YEAR })).size).to.eq(0);
    });
  });

  describe('findProfilesMissingInfo', () => {
    let host, collective, results;
    const profiles: Record<string, { id: number }> = {};

    before(async () => {
      await resetTestDB();
      host = await fakeActiveHost({
        currency: 'USD',
        data: { policies: { CONTRIBUTOR_INFO_THRESHOLDS: { legalName: 100e2, address: 500e2 } } },
      });
      collective = await fakeCollective({ HostCollectiveId: host.id, currency: 'USD' });

      const user = async (data = {}) => (await fakeUser(undefined, data)).collective;

      // Flagged
      profiles.legalNameOnly = await user();
      await contribute(host, collective, profiles.legalNameOnly.id, 200e2);
      profiles.both = await user();
      await contribute(host, collective, profiles.both.id, 700e2);
      profiles.countryOnly = await user({ legalName: 'Valid Legal Name' });
      await fakeLocation({ CollectiveId: profiles.countryOnly.id, country: 'FR', address: null, structured: {} });
      await contribute(host, collective, profiles.countryOnly.id, 600e2);
      const incognitoOwner = await fakeUser();
      profiles.incognito = incognitoOwner.collective;
      await contribute(host, collective, profiles.incognito.id, 60e2);
      await contribute(host, collective, (await fakeIncognitoProfile(incognitoOwner)).id, 60e2);
      profiles.organization = await fakeOrganization();
      await contribute(host, collective, profiles.organization.id, 150e2);
      profiles.shortLegalName = await user({ legalName: ' Bob ' });
      await contribute(host, collective, profiles.shortLegalName.id, 300e2);
      profiles.supplementaryCharacters = await user({ legalName: '𠮷田太郎' });
      await contribute(host, collective, profiles.supplementaryCharacters.id, 250e2);

      // Not flagged
      profiles.complete = await user({ legalName: 'Valid Legal Name' });
      await fakeLocation({ CollectiveId: profiles.complete.id });
      await contribute(host, collective, profiles.complete.id, 700e2);
      profiles.validShortLegalName = await user({ legalName: 'Wu Yi' });
      await contribute(host, collective, profiles.validShortLegalName.id, 300e2);
      profiles.belowThreshold = await user();
      await contribute(host, collective, profiles.belowThreshold.id, 99e2);
      profiles.refunded = await user();
      const refunded = await contribute(host, collective, profiles.refunded.id, 200e2);
      await refunded.update({ RefundTransactionId: refunded.id });
      profiles.hosted = await fakeOrganization({ HostCollectiveId: host.id });
      await contribute(host, collective, profiles.hosted.id, 700e2);
      profiles.otherYear = await user();
      await contribute(host, collective, profiles.otherYear.id, 700e2, { createdAt: new Date(Date.UTC(YEAR - 1, 5)) });

      // Hosts without effective thresholds
      const disabledHost = await fakeActiveHost({
        currency: 'USD',
        data: { policies: { CONTRIBUTOR_INFO_THRESHOLDS: {} } },
      });
      const eurHost = await fakeActiveHost({ currency: 'EUR' });
      for (const otherHost of [disabledHost, eurHost]) {
        const otherCollective = await fakeCollective({ HostCollectiveId: otherHost.id, currency: otherHost.currency });
        await contribute(otherHost, otherCollective, profiles.both.id, 700e2);
      }

      await refreshCommunityViews();
      results = await findProfilesMissingInfo({ year: YEAR });
    });

    it('flags profiles over a threshold with the matching field missing, largest total first', () => {
      expect(results).to.deep.equal([
        { hostId: host.id, profileId: profiles.both.id, total: 700e2, missingFields: ['legalName', 'address'] },
        { hostId: host.id, profileId: profiles.countryOnly.id, total: 600e2, missingFields: ['address'] },
        { hostId: host.id, profileId: profiles.shortLegalName.id, total: 300e2, missingFields: ['legalName'] },
        { hostId: host.id, profileId: profiles.supplementaryCharacters.id, total: 250e2, missingFields: ['legalName'] },
        { hostId: host.id, profileId: profiles.legalNameOnly.id, total: 200e2, missingFields: ['legalName'] },
        { hostId: host.id, profileId: profiles.organization.id, total: 150e2, missingFields: ['legalName'] },
        { hostId: host.id, profileId: profiles.incognito.id, total: 120e2, missingFields: ['legalName'] },
      ]);
    });

    it('filters by host and profile', async () => {
      expect(await findProfilesMissingInfo({ year: YEAR, profileIds: [profiles.legalNameOnly.id] })).to.have.length(1);
      expect(await findProfilesMissingInfo({ year: YEAR, hostIds: [host.id + 1000] })).to.be.empty;
      expect(await findProfilesMissingInfo({ year: YEAR - 1 })).to.containSubset([
        { profileId: profiles.otherYear.id },
      ]);
    });
  });
});
