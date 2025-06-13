import axios from 'axios';
import config from 'config';

import { AccountingCategory } from '../models';
import { ExpenseType } from '../models/Expense';

import { fetchWithTimeout } from './fetch';

const ML_SERVICE_URL = config.host.ml;
const ML_SECRET_API_KEY = process.env.ML_SECRET_API_KEY;

export type ExpenseCategoryPrediction = {
  code: string;
  name: string;
  confidence: number;
};

export type ExpensePredictions = { id: string; predictions: ExpenseCategoryPrediction[] };
export type FetchPredictionsResult = { expenses: ExpensePredictions[] };

/**
 * @deprecated Use fetchExpenseCategoryPredictionsWithSVC, fetchExpenseCategoryPredictionsWithLLM, or fetchExpenseCategoryPredictionsWithEmbedding instead.
 */
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

export async function fetchExpenseCategoryPredictionsWithSVC(
  hostSlug: string,
  mlInputs: { id: string; description: string; items: string; appliesTo: string }[],
): Promise<FetchPredictionsResult> {
  // SVC endpoint expects one expense at a time
  const results: ExpensePredictions[] = [];
  for (const input of mlInputs) {
    const params = new URLSearchParams({
      /* eslint-disable camelcase */
      host_slug: hostSlug,
      type: 'RECEIPT',
      description: input.description,
      items: input.items,
      applies_to: input.appliesTo,
      /* eslint-enable camelcase */
    });

    const url = `${ML_SERVICE_URL}/models/expense-category?${params.toString()}`;
    const response = await axios.get(url);
    results.push({ id: input.id, predictions: response.data.predictions });
  }

  return { expenses: results };
}

export async function fetchExpenseCategoryPredictionsWithLLM(
  hostSlug: string,
  mlInputs: { id: string; description: string; items: string; appliesTo: string }[],
  categories: AccountingCategory[],
): Promise<FetchPredictionsResult> {
  const url = `${ML_SERVICE_URL}/models/expense-category/llm/predict`;
  const response = await axios.post(
    url,
    {
      /* eslint-disable camelcase */
      host_slug: hostSlug,
      inputs: mlInputs.map(values => ({
        id: values.id,
        description: values.description,
        items: values.items,
      })),
      chart_of_accounts: categories.map(cat => ({
        code: cat.code,
        name: cat.name,
        friendly_name: cat.name,
        instructions: cat.instructions || '',
      })),
      /* eslint-enable camelcase */
    },
    {
      headers: {
        SECRET_API_KEY: ML_SECRET_API_KEY,
      },
    },
  );
  return { expenses: response.data.expenses };
}

export async function fetchExpenseCategoryPredictionsWithEmbedding(
  hostSlug: string,
  mlInputs: { id: string; description: string; items: string; appliesTo: string }[],
): Promise<FetchPredictionsResult> {
  const url = `${ML_SERVICE_URL}/models/expense-category/embeddings/predict`;
  const response = await axios.post(
    url,
    {
      /* eslint-disable camelcase */
      host_slug: hostSlug,
      inputs: mlInputs.map(values => ({
        ...values,
        applies_to: values.appliesTo,
      })),
      /* eslint-enable camelcase */
    },
    {
      headers: {
        SECRET_API_KEY: ML_SECRET_API_KEY,
      },
    },
  );
  return { expenses: response.data.expenses };
}
