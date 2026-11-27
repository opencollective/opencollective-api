/**
 * API check on order creation for the host's `CONTRIBUTOR_INFO_THRESHOLDS` requirements, mirroring the contribution
 * flow (see `contributor-info.ts`).
 */

import { isNil } from 'lodash';

import { CollectiveType } from '../constants/collectives';
import INTERVALS from '../constants/intervals';
import { ValidationFailed } from '../graphql/errors';
import type { Collective } from '../models';

import {
  getEffectiveContributorInfoThresholds,
  getYearlyContributedToHost,
  isExemptFromHostContributorInfo,
  isValidLegalName,
  LEGAL_NAME_MIN_LENGTH,
  locationHasAddress,
} from './contributor-info';
import { getFxRate, roundCentsAmount } from './currency';
import { mustUpdateLocation } from './location';

type ProvidedContributorInfo = {
  legalName?: string | null;
  location?: Parameters<typeof mustUpdateLocation>[1] | null;
};

/**
 * Rejects an order when the host requires a legal name or an address for the contributor's projected yearly total
 * (realized total + this order, x12 for monthly contributions) and they are missing. Mirrors the contribution flow
 * (`getRequiredInformation` in the frontend) so a client calling `createOrder` directly cannot skip the requirements.
 *
 * Call it before saving the info sent with the order on the profile, so a rejected order does not persist invalid
 * values. `providedInfo` is the legal name / location sent with the order: either it or the existing profile value
 * must satisfy each requirement (the provided one is also what counts for a guest contribution to an existing verified
 * account, whose profile is not updated). When `profileWillBeUpdated`, a provided location replaces the saved one, so
 * only the provided location counts then: a country-only location must not pass thanks to the address it replaces.
 *
 * For incognito contributions, the legal name and address of the user's main profile also count.
 */
export const assertContributorInfoForOrder = async ({
  host,
  fromCollective,
  amount,
  currency,
  interval,
  providedInfo,
  profileWillBeUpdated = true,
}: {
  host: Collective;
  fromCollective: Collective;
  /** Amount contributed by the order, in `currency`: its total without taxes and platform tip, like the yearly totals */
  amount: number;
  currency: Collective['currency'];
  interval?: string | null;
  providedInfo?: ProvidedContributorInfo | null;
  /** Whether the info sent with the order will be saved on the profile (see `checkAndUpdateProfileInfo`) */
  profileWillBeUpdated?: boolean;
}): Promise<void> => {
  if (!(amount > 0)) {
    return; // Free orders add nothing to the totals
  } else if (![CollectiveType.USER, CollectiveType.ORGANIZATION].includes(fromCollective.type as CollectiveType)) {
    return;
  } else if (isExemptFromHostContributorInfo(fromCollective, host)) {
    return;
  }

  const thresholds = getEffectiveContributorInfoThresholds(host);
  if (isNil(thresholds.legalName) && isNil(thresholds.address)) {
    return;
  }

  // Contributions made incognito count toward the user's total, and the user's info counts for them
  let profileIdForTotals = fromCollective.id;
  let mainProfile: Collective = null;
  if (fromCollective.isIncognito) {
    const incognitoMember = await fromCollective.getIncognitoMember();
    profileIdForTotals = incognitoMember?.MemberCollectiveId ?? fromCollective.id;
    mainProfile = incognitoMember?.memberCollective ?? null;
  }

  const year = new Date().getUTCFullYear();
  const totals = await getYearlyContributedToHost({ hostId: host.id, profileIds: [profileIdForTotals], year });
  const fxRate = currency === host.currency ? 1 : await getFxRate(currency, host.currency);
  const orderAmount = roundCentsAmount(amount * fxRate, host.currency) * (interval === INTERVALS.MONTH ? 12 : 1);
  const projectedTotal = (totals.get(profileIdForTotals) ?? 0) + orderAmount;

  const missing: string[] = [];
  if (!isNil(thresholds.legalName) && projectedTotal >= thresholds.legalName) {
    const legalNames = [providedInfo?.legalName, fromCollective.legalName, mainProfile?.legalName];
    if (!legalNames.some(isValidLegalName)) {
      missing.push(`legal name (at least ${LEGAL_NAME_MIN_LENGTH} characters)`);
    }
  }
  if (!isNil(thresholds.address) && projectedTotal >= thresholds.address) {
    const savedLocation = await fromCollective.getLocation();
    const replacesSavedLocation =
      profileWillBeUpdated &&
      Boolean(providedInfo?.location) &&
      mustUpdateLocation(savedLocation, providedInfo.location);
    const locations = [
      providedInfo?.location,
      !replacesSavedLocation && savedLocation,
      mainProfile && (await mainProfile.getLocation()),
    ];
    if (!locations.some(locationHasAddress)) {
      missing.push('address');
    }
  }

  if (missing.length) {
    throw new ValidationFailed(
      `${host.name} requires your ${missing.join(' and ')} for contributions of this amount. Please provide ${
        missing.length > 1 ? 'them' : 'it'
      } to continue.`,
    );
  }
};
