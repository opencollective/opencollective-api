import config from 'config';
import { get } from 'lodash';
import fetch from 'node-fetch';

const GITBOOK_API_URL = get(config, 'gitbook.apiUrl');
const GITBOOK_API_KEY = get(config, 'gitbook.apiKey');

export async function search(req, res) {
  const { query } = req.query;

  try {
    const response = await fetch(`${GITBOOK_API_URL}/v1/spaces/-LWSZizTt4ZC1UNDV89f/search?query=${query}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${GITBOOK_API_KEY}`,
      },
    });
    const data = await response.json();
    res.status(response.status).send(data);
  } catch (error) {
    res.sendStatus(500);
  }
}
