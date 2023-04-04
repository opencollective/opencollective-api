import Axios from 'axios';
import config from 'config';
import { get } from 'lodash';

const GITBOOK_API_URL = get(config, 'gitbook.apiUrl');
const GITBOOK_API_KEY = get(config, 'gitbook.apiKey');

const axios = Axios.create({
  baseURL: GITBOOK_API_URL,
  headers: {
    Authorization: `Bearer ${GITBOOK_API_KEY}`,
  },
});

export async function search(req, res) {
  const { query } = req.query;

  try {
    const { data } = axios.get(`/v1/spaces/-LWSZizTt4ZC1UNDV89f/search?query=${query}`);
    res.status(200).send(data);
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status).send(error.response.data);
    }
    res.sendStatus(500);
  }
}
