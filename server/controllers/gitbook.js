import config from 'config';
import { get } from 'lodash';

const GITBOOK_API_URL = get(config, 'gitbook.apiUrl');
const GITBOOK_API_KEY = get(config, 'gitbook.apiKey');
const GITBOOK_SPACE_ID = get(config, 'gitbook.spaceId');

export async function search(req, res) {
  const { query } = req.query;

  if (typeof query !== 'string') {
    return res.status(400).send('A query string is required');
  }

  try {
    const url = new URL(`/v1/spaces/${GITBOOK_SPACE_ID}/search`, GITBOOK_API_URL);
    url.searchParams.set('query', query);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${GITBOOK_API_KEY}`,
      },
    });
    const data = await response.json();
    res.status(response.status).send(data);
  } catch {
    res.sendStatus(500);
  }
}
