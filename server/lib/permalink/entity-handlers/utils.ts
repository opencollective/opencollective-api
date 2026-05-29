import express from 'express';

export type Handler = (req: express.Request, res: express.Response) => Promise<void>;

export const notFound = (res: express.Response) => res.redirect(302, '/not-found');
export const redirect = (res: express.Response, url: string) => res.redirect(302, url);
export const accessDenied = (res: express.Response) => res.redirect(302, '/access-denied');

export const getDashboardRoute = (
  account,
  section: string | null = null,
  params: Record<string, string | number | null | undefined> = {},
) => {
  if (!account?.slug) {
    return '';
  }

  const route = `/dashboard/${account.slug}${section ? `/${section}` : ''}`;
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) {
      searchParams.set(key, String(value));
    }
  }

  const query = searchParams.toString();
  return query ? `${route}?${query}` : route;
};

export const getCollectivePageRoute = async (collective: any): Promise<string> => {
  if (!collective) {
    return '';
  }

  if (collective.type === 'EVENT' || collective.type === 'PROJECT') {
    const parentCollective =
      collective.parentCollective ||
      collective.parent ||
      (collective.getParentCollective ? await collective.getParentCollective() : null);
    const parentSlug = parentCollective?.slug || 'collective';
    return `/${parentSlug}/${collective.type === 'EVENT' ? 'events' : 'projects'}/${collective.slug}`;
  }

  return `/${collective.slug}`;
};
