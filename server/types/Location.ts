export type Location = {
  name?: string | null;
  address?: string | null;
  country?: string | null;
  structured?: StructuredAddress | null;
  lat?: number | null;
  long?: number | null;
};

export type StructuredAddress = {
  address1?: string;
  address2?: string;
  city?: string;
  postalCode?: string;
  zone?: string;
};
