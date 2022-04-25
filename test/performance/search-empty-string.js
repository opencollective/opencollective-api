/* eslint-disable camelcase */

import { check, sleep } from 'k6';
import http from 'k6/http';

export const options = {
  duration: '30s',
  vus: 500,
  thresholds: {
    http_req_failed: ['rate<0.01'], // http errors should be less than 1%
    http_req_duration: ['p(95)<1000'], // 95 percent of response times must be below 1s
  },
};

const searchQuery = `
  query Search {
    accounts(orderBy: { field: ACTIVITY, direction: DESC }) {
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
  const res = http.post('http://localhost:3060/graphql/v2', JSON.stringify({ query: searchQuery }), {
    headers: headers,
  });

  if (check(res, { 'status was 200': r => r.status === 200 })) {
    check(JSON.parse(res.body), {
      'no error': r => !r.errors,
      'has results': r => r.data.accounts.totalCount > 0,
    });
  }
}

// export function handleSummary({ metrics }) {
//   return {
//     'output/benchmarks/search-empty-string.json': JSON.stringify(metrics, null, 2),
//   };
// }
