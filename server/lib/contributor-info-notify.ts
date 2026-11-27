/**
 * Emails contributors who reached a host's `CONTRIBUTOR_INFO_THRESHOLDS` without the matching information on their
 * profile. Shared by the daily cron and the manual script, so both apply the same dedup and reminder rules. Also sends
 * the manual requests of host admins (`requestContributorInfo` mutation), recorded the same way.
 *
 * State lives in the profile's `contributor.info.requested` activities, one entry per host and year.
 */

import { createHash } from 'crypto';

import { groupBy, isEmpty, uniq } from 'lodash';
import moment from 'moment';

import ActivityTypes from '../constants/activities';
import { CollectiveType } from '../constants/collectives';
import { Activity, Collective, Location, Op, User } from '../models';

import { findProfilesMissingInfo, isValidLegalName, locationHasAddress } from './contributor-info';
import emailLib, { getTemplateAttributes } from './email';
import logger from './logger';
import { reportErrorToSentry } from './sentry';

const TEMPLATE = ActivityTypes.CONTRIBUTOR_INFO_REQUESTED;

type MissingField = 'legalName' | 'address';

/** Parts of a structured address a host can ask to correct, as stored in `Location.structured` (plus the country) */
export type AddressPart = 'address1' | 'address2' | 'city' | 'postalCode' | 'zone' | 'country';

type ActivityHostEntry = {
  id: number;
  slug: string;
  name: string;
  year: number;
  missingFields: MissingField[];
  isReminder: boolean;
  /** Manual requests only: the address parts to correct, empty for the whole address */
  addressParts?: AddressPart[];
};

type ProfileStatus = 'sent' | 'wouldSend' | 'deduped' | 'noRecipient' | 'leftOver' | 'failed';

type HostEntryAction = 'request' | 'reminder' | 'deduped';

type ProfileReport = {
  profileId: number;
  slug: string;
  status: ProfileStatus;
  isReminder: boolean;
  recipients: number;
  hosts: { hostId: number; year: number; total: number; missingFields: MissingField[]; action: HostEntryAction }[];
};

type HostReport = {
  hostId: number;
  slug: string;
  candidates: number;
  deduped: number;
  requests: number;
  reminders: number;
  sent: number;
  leftOver: number;
  skipped: number;
};

type NotifyReport = { dryRun: boolean; recipients: number; profiles: ProfileReport[]; hosts: HostReport[] };

const parseNonNegativeInt = (value: string | undefined, defaultValue: number): number => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isInteger(parsed) && parsed >= 0 ? parsed : defaultValue;
};

/** Days between a request and its reminder (`CONTRIBUTOR_MISSING_INFO_REMINDER_DAYS`, default 30) */
const getReminderDays = (): number => parseNonNegativeInt(process.env.CONTRIBUTOR_MISSING_INFO_REMINDER_DAYS, 30);

/**
 * Years to process: the current one, plus the previous one during the first
 * `CONTRIBUTOR_MISSING_INFO_PRIOR_YEAR_DAYS` (default 90) days of the year, UTC.
 */
export const getYearsToProcess = (now = new Date()): number[] => {
  const priorYearDays = parseNonNegativeInt(process.env.CONTRIBUTOR_MISSING_INFO_PRIOR_YEAR_DAYS, 90);
  const year = now.getUTCFullYear();
  const daysSinceNewYear = (now.getTime() - Date.UTC(year, 0, 1)) / (24 * 60 * 60 * 1000);
  return daysSinceNewYear < priorYearDays ? [year, year - 1] : [year];
};

/**
 * Decides what to do for one host and year, from the earlier activity entries for that host and year:
 * - `request` when the missing fields are not all covered by earlier entries (first time, or more fields missing);
 * - `reminder` when they are, the latest request is at least `reminderDays` old and has no reminder yet;
 * - `deduped` otherwise.
 */
const getHostEntryAction = (
  missingFields: MissingField[],
  history: { createdAt: Date; entry: ActivityHostEntry }[],
  now: Date,
  reminderDays: number,
): HostEntryAction => {
  const covered = new Set(history.flatMap(h => h.entry.missingFields));
  if (missingFields.some(field => !covered.has(field))) {
    return 'request';
  }

  const requests = history.filter(h => !h.entry.isReminder);
  const lastRequest = requests[requests.length - 1];
  if (!lastRequest) {
    return 'request'; // Should not happen: reminders always follow a request
  }

  const hasReminder = history.some(h => h.entry.isReminder && h.createdAt > lastRequest.createdAt);
  const reminderDue = moment(lastRequest.createdAt).add(reminderDays, 'days').toDate() <= now;
  return !hasReminder && reminderDue ? 'reminder' : 'deduped';
};

const FIELD_LABELS: Record<MissingField, string> = { legalName: 'legal name', address: 'address' };

/** Users to email for a profile: the user itself, or the active admins of an organization */
const getRecipients = async (profile: Collective): Promise<User[]> => {
  const users = await profile.getAdminUsers();
  return users.filter(user => user?.email);
};

/**
 * Renders and sends the email to one user. Throws if the template fails to render or the mailer rejects, unlike
 * `emailLib.send` which only logs: the activity must only be saved after a confirmed send.
 */
const sendEmail = async (user: User, data: Record<string, unknown>): Promise<void> => {
  const options = { isTransactional: true };
  const rendered = emailLib.generateEmailFromTemplate(TEMPLATE, user.email, data, options);
  const { subject, body } = getTemplateAttributes(rendered.html);
  await emailLib.sendMessage(user.email, subject, body, { ...options, text: rendered.text, tag: TEMPLATE });
};

export const notifyContributorsMissingInfo = async ({
  years,
  hostIds,
  profileIds,
  limit,
  dryRun,
  ignoreDedup = false,
  now = new Date(),
}: {
  years: number[];
  hostIds?: number[];
  profileIds?: number[];
  /** Max recipients for this run. A profile is never split, but the first one is always processed. */
  limit?: number;
  dryRun: boolean;
  /** Send even if already requested (manual runs on specific profiles only) */
  ignoreDedup?: boolean;
  now?: Date;
}): Promise<NotifyReport> => {
  const reminderDays = getReminderDays();
  const report: NotifyReport = { dryRun, recipients: 0, profiles: [], hosts: [] };

  // Candidates for all years, grouped by profile (largest total first, as returned by the query)
  const rows = (
    await Promise.all(
      years.map(async year =>
        (await findProfilesMissingInfo({ year, hostIds, profileIds })).map(row => ({ ...row, year })),
      ),
    )
  ).flat();
  rows.sort((a, b) => b.total - a.total);
  if (!rows.length) {
    return report;
  }

  const rowsByProfile = groupBy(rows, 'profileId');
  const orderedProfileIds = uniq(rows.map(r => r.profileId));
  const [profiles, hosts, activities] = await Promise.all([
    Collective.findAll({ where: { id: orderedProfileIds } }),
    Collective.findAll({ where: { id: uniq(rows.map(r => r.hostId)) }, attributes: ['id', 'slug', 'name'] }),
    Activity.findAll({
      where: { type: TEMPLATE, CollectiveId: orderedProfileIds, createdAt: { [Op.lte]: now } },
      attributes: ['id', 'CollectiveId', 'createdAt', 'data'],
      order: [['createdAt', 'ASC']],
    }),
  ]);
  const profilesById = new Map(profiles.map(p => [p.id, p]));
  const hostsById = new Map(hosts.map(h => [h.id, h]));
  const activitiesByProfile = groupBy(activities, 'CollectiveId');

  const hostReports = new Map<number, HostReport>();
  const getHostReport = (hostId: number) => {
    if (!hostReports.has(hostId)) {
      const slug = hostsById.get(hostId)?.slug;
      hostReports.set(hostId, {
        hostId,
        slug,
        candidates: 0,
        deduped: 0,
        requests: 0,
        reminders: 0,
        sent: 0,
        leftOver: 0,
        skipped: 0,
      });
    }
    return hostReports.get(hostId);
  };

  for (const profileId of orderedProfileIds) {
    const profile = profilesById.get(profileId);
    const history = (activitiesByProfile[profileId] || []).flatMap(activity =>
      ((activity.data?.hosts || []) as ActivityHostEntry[]).map(entry => ({ createdAt: activity.createdAt, entry })),
    );

    const hostEntries = rowsByProfile[profileId].map(row => {
      const entryHistory = history.filter(h => h.entry.id === row.hostId && h.entry.year === row.year);
      const action = ignoreDedup ? 'request' : getHostEntryAction(row.missingFields, entryHistory, now, reminderDays);
      return { hostId: row.hostId, year: row.year, total: row.total, missingFields: row.missingFields, action };
    });

    const profileReport: ProfileReport = {
      profileId,
      slug: profile?.slug,
      status: 'deduped',
      isReminder: false,
      recipients: 0,
      hosts: hostEntries,
    };
    report.profiles.push(profileReport);

    const toSend = hostEntries.filter(e => e.action !== 'deduped');
    const countHosts = (key: keyof HostReport, entries = toSend) =>
      entries.forEach(e => ((getHostReport(e.hostId)[key] as number) += 1));
    countHosts('candidates', hostEntries);
    countHosts(
      'deduped',
      hostEntries.filter(e => e.action === 'deduped'),
    );
    if (!toSend.length || !profile) {
      continue;
    }

    countHosts(
      'requests',
      toSend.filter(e => e.action === 'request'),
    );
    countHosts(
      'reminders',
      toSend.filter(e => e.action === 'reminder'),
    );
    profileReport.isReminder = toSend.every(e => e.action === 'reminder');

    const recipients = await getRecipients(profile);
    profileReport.recipients = recipients.length;
    if (!recipients.length) {
      profileReport.status = 'noRecipient';
      countHosts('skipped');
      logger.warn(`contributor-info: no recipient for profile #${profile.id} (${profile.slug}), skipping`);
      continue;
    }

    // Never split a profile across runs, but always process the first one so a large organization is still served
    const isFirst = report.recipients === 0 && limit > 0;
    if (limit !== undefined && !isFirst && report.recipients + recipients.length > limit) {
      profileReport.status = 'leftOver';
      countHosts('leftOver');
      continue;
    }

    const activityHosts: ActivityHostEntry[] = toSend.map(e => {
      const host = hostsById.get(e.hostId);
      return {
        id: e.hostId,
        slug: host?.slug,
        name: host?.name,
        year: e.year,
        missingFields: e.missingFields,
        isReminder: e.action === 'reminder',
      };
    });

    report.recipients += recipients.length;
    if (dryRun) {
      profileReport.status = 'wouldSend';
      countHosts('sent');
      continue;
    }

    // One host per line, merging years: the profile information is the same for all of them
    const emailHosts = Object.values(groupBy(activityHosts, 'id')).map(entries => ({
      name: entries[0].name,
      fieldsLabel: uniq(entries.flatMap(e => e.missingFields))
        .map(field => FIELD_LABELS[field])
        .join(' and '),
    }));

    let sentTo: User[] = [];
    for (const user of recipients) {
      try {
        await sendEmail(user, {
          collective: { name: profile.name, slug: profile.slug, type: profile.type },
          recipientName: profile.type === CollectiveType.USER ? profile.name : null,
          isOrganization: profile.type === CollectiveType.ORGANIZATION,
          isReminder: profileReport.isReminder,
          hosts: emailHosts,
          hasSeveralHosts: emailHosts.length > 1,
        });
        sentTo = [...sentTo, user];
      } catch (error) {
        logger.error(`contributor-info: failed to email user #${user.id} for profile #${profile.id}: ${error.message}`);
        reportErrorToSentry(error, { extra: { profileId: profile.id, userId: user.id } });
      }
    }

    // Only record the request after a confirmed send, so a failed send is retried on the next run
    if (!sentTo.length) {
      profileReport.status = 'failed';
      continue;
    }

    await Activity.create({
      type: TEMPLATE,
      CollectiveId: profile.id,
      FromCollectiveId: profile.id,
      UserId: sentTo[0].id,
      data: {
        notify: false,
        isReminder: profileReport.isReminder,
        hosts: activityHosts,
        recipientIds: sentTo.map(u => u.id),
      },
    });
    profileReport.status = 'sent';
    countHosts('sent');
  }

  report.hosts = Array.from(hostReports.values());
  return report;
};

const ADDRESS_PART_LABELS: Record<AddressPart, string> = {
  address1: 'street address',
  address2: 'address line 2',
  city: 'city',
  postalCode: 'postal code',
  zone: 'state or region',
  country: 'country',
};

/**
 * Sends a host admin's request to add or correct a profile's information, with an optional message. Recorded as a
 * request for the current year, so the daily job does not send a duplicate one and reminds the contributor later if
 * the information is still missing. The activity is only saved after a confirmed send.
 */
export const sendManualContributorInfoRequest = async ({
  host,
  profile,
  fields,
  addressParts = [],
  message,
  requestedBy,
  now = new Date(),
}: {
  host: Collective;
  profile: Collective;
  fields: MissingField[];
  addressParts?: AddressPart[];
  message?: string;
  requestedBy: User;
  now?: Date;
}): Promise<{ recipients: number; sentTo: User[] }> => {
  const recipients = await getRecipients(profile);
  const items = [
    fields.includes('legalName') && 'Legal name',
    fields.includes('address') &&
      (addressParts.length ? `Address: ${addressParts.map(part => ADDRESS_PART_LABELS[part]).join(', ')}` : 'Address'),
  ].filter(Boolean);

  let sentTo: User[] = [];
  for (const user of recipients) {
    try {
      await sendEmail(user, {
        collective: { name: profile.name, slug: profile.slug, type: profile.type },
        recipientName: profile.type === CollectiveType.USER ? profile.name : null,
        isOrganization: profile.type === CollectiveType.ORGANIZATION,
        isManual: true,
        hostName: host.name,
        items,
        message: message || null,
      });
      sentTo = [...sentTo, user];
    } catch (error) {
      logger.error(`contributor-info: failed to email user #${user.id} for profile #${profile.id}: ${error.message}`);
      reportErrorToSentry(error, { extra: { profileId: profile.id, userId: user.id, hostId: host.id } });
    }
  }

  if (sentTo.length) {
    const location = await profile.getLocation();
    const entry: ActivityHostEntry = {
      id: host.id,
      slug: host.slug,
      name: host.name,
      year: now.getUTCFullYear(),
      missingFields: fields,
      isReminder: false,
      addressParts: fields.includes('address') ? addressParts : [],
    };
    await Activity.create({
      type: TEMPLATE,
      CollectiveId: profile.id,
      FromCollectiveId: profile.id,
      HostCollectiveId: host.id,
      UserId: requestedBy.id,
      data: {
        notify: false,
        isManual: true,
        isReminder: false,
        hosts: [entry],
        fingerprints: getFingerprints(profile, location, fields, entry.addressParts),
        message: message || null,
        recipientIds: sentTo.map(u => u.id),
      },
    });
  }

  return { recipients: recipients.length, sentTo };
};

/** Short hash of a value, to detect later changes without storing personal information in the activity */
const fingerprint = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('base64url')
    .slice(0, 22);

const trimmed = (value: unknown): string | null => (isEmpty(String(value ?? '').trim()) ? null : String(value).trim());

/** Fingerprints of the requested values: `legalName`, `address` (whole address) or `address.<part>` */
const getFingerprints = (
  profile: Collective,
  location: Location | null,
  fields: MissingField[],
  addressParts: AddressPart[] = [],
): Record<string, string> => {
  const values: Record<string, unknown> = {};
  if (fields.includes('legalName')) {
    values.legalName = trimmed(profile.legalName);
  }
  if (fields.includes('address') && !addressParts.length) {
    values.address = { address: location?.address, structured: location?.structured, country: location?.country };
  }
  if (fields.includes('address')) {
    for (const part of addressParts) {
      values[`address.${part}`] = trimmed(part === 'country' ? location?.country : location?.structured?.[part]);
    }
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, fingerprint(value)]));
};

/** Requests older than this are not reported as pending */
const PENDING_REQUEST_DAYS = 365;

/**
 * What the host asked for and the contributor did not provide yet, from all the host's requests of the last
 * `PENDING_REQUEST_DAYS` days:
 * - manual requests: the requested values did not change since the request (compared through fingerprints);
 * - automatic requests: the information is still missing.
 * Returns null when nothing is pending.
 */
export const getPendingContributorInfoRequest = async ({
  host,
  profile,
  now = new Date(),
}: {
  host: Collective;
  profile: Collective;
  now?: Date;
}): Promise<{ requestedAt: Date; fields: MissingField[]; addressParts: AddressPart[] } | null> => {
  const activities = await Activity.findAll({
    where: {
      type: TEMPLATE,
      CollectiveId: profile.id,
      createdAt: { [Op.gte]: moment(now).subtract(PENDING_REQUEST_DAYS, 'days').toDate(), [Op.lte]: now },
    },
    attributes: ['id', 'createdAt', 'data'],
    order: [['createdAt', 'ASC']],
  });
  if (!activities.length) {
    return null;
  }

  const location = await profile.getLocation();
  const isMissing: Record<MissingField, boolean> = {
    legalName: !isValidLegalName(profile.legalName),
    address: !locationHasAddress(location),
  };

  let requestedAt: Date = null;
  const fields = new Set<MissingField>();
  const addressParts = new Set<AddressPart>();
  let wholeAddress = false;
  for (const activity of activities) {
    const entries = ((activity.data?.hosts || []) as ActivityHostEntry[]).filter(entry => entry.id === host.id);
    for (const entry of entries) {
      let pending: MissingField[];
      if (activity.data?.fingerprints) {
        const current = getFingerprints(profile, location, entry.missingFields, entry.addressParts);
        const unchanged = Object.keys(current).filter(key => current[key] === activity.data.fingerprints[key]);
        pending = entry.missingFields.filter(field => unchanged.some(key => key.split('.')[0] === field));
        unchanged
          .filter(key => key.startsWith('address.'))
          .forEach(key => addressParts.add(key.split('.')[1] as AddressPart));
        wholeAddress = wholeAddress || unchanged.includes('address');
      } else {
        pending = entry.missingFields.filter(field => isMissing[field]);
        wholeAddress = wholeAddress || pending.includes('address');
      }

      if (pending.length) {
        pending.forEach(field => fields.add(field));
        requestedAt = activity.createdAt;
      }
    }
  }

  if (!fields.size) {
    return null;
  }

  return { requestedAt, fields: Array.from(fields), addressParts: wholeAddress ? [] : Array.from(addressParts) };
};
