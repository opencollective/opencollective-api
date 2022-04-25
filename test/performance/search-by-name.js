/* eslint-disable camelcase */

import { check } from 'k6';
import http from 'k6/http';
import { randomString } from 'k6/utils';

export const options = {
  duration: '30s',
  vus: 150,
  thresholds: {
    http_req_failed: ['rate<0.01'], // http errors should be less than 1%
    http_req_duration: ['p(95)<1000'], // 95 percent of response times must be below 1s
  },
};

const searchQuery = `
  query Search($term: String) {
    accounts(searchTerm: $term, orderBy: { field: 'ACTIVITY', direction: 'DESC' }) {
      totalCount
      limit
      offset
      nodes {
        id
        name
        slug
      }
    }
  }
`;

const headers = {
  'Content-Type': 'application/json',
};

export default function () {
  const res = http.post(
    'http://localhost:3060/graphql/v2',
    JSON.stringify({
      query: searchQuery,
      variables: {
        term: randomString(),
      },
    }),
    {
      headers: headers,
    },
  );

  if (check(res, { 'status was 200': r => r.status === 200 })) {
    console.log(JSON.stringify(res));
    console.log(JSON.stringify(res.body));
    check(JSON.parse(res.body), {
      'no error': r => !r.errors,
      'has results': r => r.data.accounts.totalCount > 0,
    });
  }
}

// export function handleSummary({ metrics }) {
//   return {
//     'output/benchmarks/search-by-name.json': JSON.stringify(metrics, null, 2),
//   };
// }
