import { type Handler, notFound, unauthorized } from './utils';

export const handleNotFound: Handler = async (_req, res) => {
  return notFound(res);
};

export const handleUnauthorized: Handler = async (_req, res) => {
  return unauthorized(res);
};
