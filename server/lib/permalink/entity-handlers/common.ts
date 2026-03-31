import { accessDenied, type Handler, notFound, redirect } from './utils';

export const handleNotFound: Handler = async (_req, res) => {
  return notFound(res);
};

export const handleAccessDenied: Handler = async (_req, res) => {
  return accessDenied(res);
};

export const handleUnauthorized: Handler = async (_req, res) => {
  const id = _req.params.id;
  return redirect(res, `/signin?next=${encodeURIComponent(`/permalink/${id}`)}`);
};
