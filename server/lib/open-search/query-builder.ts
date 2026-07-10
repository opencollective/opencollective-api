import { QueryContainer } from '@opensearch-project/opensearch/api/_types/_common.query_dsl.js';
import { isNil } from 'lodash';

import { OpenSearchModelAdapter } from './adapters/OpenSearchModelAdapter';
import { OpenSearchIndexName } from './constants';

const EXACT_SLUG_BOOST = 50;
const EXACT_KEYWORD_BOOST = 40;
const PHRASE_MATCH_BOOST = 15;
const PHRASE_PREFIX_BOOST = 12;

const isMultiWordQuery = (searchTerm: string) => /\s/.test(searchTerm.trim());

const getFieldMapping = (adapter: OpenSearchModelAdapter, field: string) => {
  return adapter.mappings.properties?.[field];
};

const getFieldWeight = (adapter: OpenSearchModelAdapter, field: string): number => {
  const weight = adapter.weights[field];
  return isNil(weight) ? 1 : weight;
};

const addWeightToField = (adapter: OpenSearchModelAdapter, field: string): string => {
  const weight = getFieldWeight(adapter, field);
  if (weight === 1) {
    return field;
  }
  return `${field}^${weight}`;
};

const getKeywordSubfields = (adapter: OpenSearchModelAdapter, publicFields: string[]): string[] => {
  return publicFields.flatMap(field => {
    const mapping = getFieldMapping(adapter, field);
    if (mapping?.type === 'text' && mapping.fields?.['keyword']) {
      return [`${field}.keyword`];
    }
    return [];
  });
};

const getKeywordTextSubfields = (adapter: OpenSearchModelAdapter, publicFields: string[]): string[] => {
  return publicFields.flatMap(field => {
    const mapping = getFieldMapping(adapter, field);
    if (mapping?.type === 'keyword' && mapping.fields?.['text']) {
      return [`${field}.text`];
    }
    return [];
  });
};

const getMultiMatchFields = (adapter: OpenSearchModelAdapter, publicFields: string[]): string[] => {
  return publicFields.flatMap(field => {
    const mapping = getFieldMapping(adapter, field);
    if (mapping?.type === 'keyword' && mapping.fields?.['text']) {
      const weight = getFieldWeight(adapter, field);
      const textField = `${field}.text`;
      return weight === 1 ? textField : `${textField}^${weight}`;
    }
    return addWeightToField(adapter, field);
  });
};

export const buildDefaultTextShouldClauses = (
  adapter: OpenSearchModelAdapter,
  searchTerm: string,
  publicFields: string[],
): QueryContainer[] => {
  const clauses: QueryContainer[] = [];

  /* eslint-disable camelcase */

  // Exact match on keyword fields with an explicit weight (slug always gets a high boost)
  for (const field of publicFields) {
    if (getFieldMapping(adapter, field)?.type !== 'keyword') {
      continue;
    }

    const weight = adapter.weights[field];
    if (field !== 'slug' && (weight === undefined || weight === 0)) {
      continue;
    }

    clauses.push({
      term: {
        [field]: {
          value: searchTerm,
          boost: field === 'slug' ? EXACT_SLUG_BOOST : weight * 5,
        },
      },
    });
  }

  // Exact match on keyword subfields (e.g. name.keyword)
  for (const field of getKeywordSubfields(adapter, publicFields)) {
    clauses.push({
      term: {
        [field]: {
          value: searchTerm,
          boost: EXACT_KEYWORD_BOOST,
        },
      },
    });
  }

  // Phrase match on text fields for multi-word queries
  if (isMultiWordQuery(searchTerm)) {
    for (const field of publicFields) {
      if (getFieldMapping(adapter, field)?.type === 'text') {
        clauses.push({
          match_phrase: {
            [field]: {
              query: searchTerm,
              boost: PHRASE_MATCH_BOOST * getFieldWeight(adapter, field),
            },
          },
        });
      }
    }
  }

  // Token/phrase/prefix match on keyword .text subfields (e.g. slug.text)
  for (const field of getKeywordTextSubfields(adapter, publicFields)) {
    const baseField = field.replace(/\.text$/, '');
    const weight = getFieldWeight(adapter, baseField);

    if (isMultiWordQuery(searchTerm)) {
      clauses.push({
        match_phrase: {
          [field]: {
            query: searchTerm,
            boost: PHRASE_MATCH_BOOST * weight,
          },
        },
      });
    }

    clauses.push({
      match: {
        [field]: {
          query: searchTerm,
          operator: 'or',
          boost: weight,
        },
      },
    });

    clauses.push({
      match_phrase_prefix: {
        [field]: {
          query: searchTerm,
          boost: PHRASE_PREFIX_BOOST * weight,
        },
      },
    });
  }

  // Prefix match on text fields (e.g. name)
  for (const field of publicFields) {
    if (getFieldMapping(adapter, field)?.type === 'text') {
      clauses.push({
        match_phrase_prefix: {
          [field]: {
            query: searchTerm,
            boost: PHRASE_PREFIX_BOOST * getFieldWeight(adapter, field),
          },
        },
      });
    }
  }

  // Broad token match fallback (fuzziness only here)
  clauses.push({
    multi_match: {
      query: searchTerm,
      type: 'best_fields',
      operator: 'or',
      fuzziness: 'AUTO',
      fields: getMultiMatchFields(adapter, publicFields),
    },
  });

  /* eslint-enable camelcase */
  return clauses;
};

export const buildTextShouldClauses = (
  adapter: OpenSearchModelAdapter,
  searchTerm: string,
  publicFields: string[],
): QueryContainer[] => {
  if (adapter.getTextQueryClauses) {
    return adapter.getTextQueryClauses(searchTerm, publicFields);
  }

  return buildDefaultTextShouldClauses(adapter, searchTerm, publicFields);
};

export const buildPrivateFieldShouldClauses = (
  adapter: OpenSearchModelAdapter,
  searchTerm: string,
  field: string,
): QueryContainer[] => {
  const fieldType = getFieldMapping(adapter, field)?.type;
  const weight = getFieldWeight(adapter, field);
  const clauses: QueryContainer[] = [];

  /* eslint-disable camelcase */

  if (fieldType === 'keyword') {
    clauses.push({
      term: {
        [field]: {
          value: searchTerm,
          boost: weight * 5,
        },
      },
    });
  }

  if (isMultiWordQuery(searchTerm) && fieldType === 'text') {
    clauses.push({
      match_phrase: {
        [field]: {
          query: searchTerm,
          boost: PHRASE_MATCH_BOOST * weight,
        },
      },
    });
  }

  clauses.push({
    match: {
      [field]: {
        query: searchTerm,
        fuzziness: 'AUTO',
        boost: weight,
      },
    },
  });

  /* eslint-enable camelcase */
  return clauses;
};

export const buildTrustFunctionScore = (query: QueryContainer): QueryContainer => ({
  /* eslint-disable camelcase */
  function_score: {
    query,
    score_mode: 'sum',
    boost_mode: 'sum',
    functions: [
      { filter: { term: { isFirstPartyHost: true } }, weight: 3 },
      { filter: { term: { isTrustedHost: true } }, weight: 2 },
      { filter: { term: { isVerified: true } }, weight: 1.5 },
    ],
  },
  /* eslint-enable camelcase */
});

export const wrapIndexTextQuery = (index: OpenSearchIndexName, textQuery: QueryContainer): QueryContainer => {
  if (index === OpenSearchIndexName.COLLECTIVES) {
    return buildTrustFunctionScore(textQuery);
  }

  return textQuery;
};
