export type Location = {
  name?: string | null;
  country?: string | null;
  address?: string | null;
  structured?: Record<string, string> | null;
  lat?: number | null;
  long?: number | null;
};
