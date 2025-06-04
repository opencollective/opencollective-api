import config from 'config';

import { ExpenseType } from '../models/Expense';

import { fetchWithTimeout } from './fetch';

const ML_SERVICE_URL = config.host.ml;

type ExpenseCategoryPrediction = {
  code: string;
  name: string;
  confidence: number;
};

export const fetchExpenseCategoryPredictions = async ({
  hostSlug,
  accountSlug,
  type,
  description,
  items,
  timeoutInMs = 6_000,
}: {
  hostSlug: string;
  accountSlug: string;
  type: ExpenseType;
  description: string;
  items: Array<{ description?: string }>;
  timeoutInMs?: number;
}) => {
  if (!ML_SERVICE_URL) {
    return [];
  }

  const cleanStr = (str: string) => (!str ? '' : str.trim().toLocaleLowerCase());
  const urlParams = new URLSearchParams();
  urlParams.append('host_slug', hostSlug);
  urlParams.append('collective_slug', accountSlug);
  urlParams.append('type', type);
  urlParams.append('description', cleanStr(description));
  urlParams.append(
    'items',
    items
      .map(item => cleanStr(item.description))
      .filter(Boolean)
      .join(' | '),
  );

  const response = await fetchWithTimeout(`${ML_SERVICE_URL}/models/expense-category?${urlParams}`, {
    timeoutInMs,
  });

  const data = await response.json();
  return data.predictions as ExpenseCategoryPrediction[];
};
