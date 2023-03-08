export type Location = {
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  postalCode?: string | null;
  zone?: string | null;
  country?: string | null;
  formattedAddress?: string | null;
  address?: string | null;
  structured?: Record<string, string> | null;
};
