import { omit, pick } from 'lodash';

import { mergeDataDeep } from '../../../migrations/lib/helpers';
import { getSpamReportCollectiveSnapshot } from '../spam';

export const COLLECTIVE_SNAPSHOT_KEYS = [
  'collective',
  'host',
  'fromCollective',
  'toCollective',
  'movedFromCollective',
] as const;

export const stripDataKey = <T extends Record<string, unknown>>(obj: T): Omit<T, 'data'> => {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  return omit(obj, 'data') as Omit<T, 'data'>;
};

export const slimSpamReportData = (data: unknown): Record<string, unknown> | null => {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const snapshot = data as Record<string, unknown>;
  if (snapshot.data || 'settings' in snapshot || 'tiers' in snapshot) {
    return getSpamReportCollectiveSnapshot(snapshot);
  }

  return pick(snapshot, ['id', 'slug', 'type', 'name', 'website', 'description', 'longDescription']);
};

export const cleanupCollectiveDataJsonb = (data: Record<string, unknown>): Record<string, unknown> => {
  if (!data) {
    return data;
  }

  let result = { ...data };

  if (result.data) {
    result = mergeDataDeep(result);
    result = omit(result, 'data') as Record<string, unknown>;
  }

  if (result.spamReport && typeof result.spamReport === 'object') {
    const spamReport = { ...(result.spamReport as Record<string, unknown>) };
    if (spamReport.data) {
      const slimData = slimSpamReportData(spamReport.data);
      if (slimData) {
        spamReport.data = slimData;
      } else {
        delete spamReport.data;
      }
    }

    result.spamReport = spamReport;
  }

  return result;
};

export const cleanupActivityDataJsonb = (data: Record<string, unknown>): Record<string, unknown> => {
  if (!data) {
    return data;
  }

  const result = { ...data };

  for (const key of COLLECTIVE_SNAPSHOT_KEYS) {
    if (result[key] && typeof result[key] === 'object') {
      result[key] = stripDataKey(result[key] as Record<string, unknown>);
    }
  }

  for (const key of ['previousData', 'newData']) {
    if (result[key] && typeof result[key] === 'object') {
      result[key] = stripDataKey(result[key] as Record<string, unknown>);
    }
  }

  return result;
};

export const jsonbSize = (data: unknown): number => Buffer.byteLength(JSON.stringify(data ?? null), 'utf8');
