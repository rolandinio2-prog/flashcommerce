import FlashMenuClient from './components/flash-menu-client';

interface Product {
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

interface Catalog {
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

async function getCatalog(): Promise<Catalog> {
  const apiUrl = process.env.FLASH_API_URL;

  if (!apiUrl) {
    throw new Error('FLASH_API_URL is not configured');
  }

  const response = await fetch(
    `${apiUrl}/api/v1/catalog?tenant=POLLO001&branch=SUC001`,
    {
      cache: 'no-store',
    },
  );

  if (!response.ok) {
    throw new Error(
      `Catalog request failed: ${response.status}`,
    );
  }

  return response.json();
}

export default async function Home() {
  const catalog = await getCatalog();

  return <FlashMenuClient catalog={catalog} />;
}