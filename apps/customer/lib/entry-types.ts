interface Product {
  hasGarnishes?: boolean;
  garnishParentId?: string | null;
  garnishLabel?: string | null;
  garnishImageUrl?: string | null;
  garnishSortOrder?: number;

  hasPresentations?: boolean;
  presentationParentId?: string | null;
  presentationLabel?: string | null;
  presentationSortOrder?: number;

  id: string;
  sku: string | null;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number;
  currency: string;
  available: boolean;
  availableQuantity: number | null;
  preparationMinutes: number;
}

interface Category {
  id: string;
  name: string;
  slug: string;
  sortOrder: number;
  products: Product[];
}

export interface Catalog {
  tenant: {
    code: string;
    name: string;
  };
  branch: {
    code: string;
    name: string;
    timezone: string;
  };
  categories: Category[];
}

export type EntryQuery = Record<string, string | string[] | undefined>;
export interface BranchDirectory { tenant: { code: string; name: string }; branches: { code: string; name: string }[] }
