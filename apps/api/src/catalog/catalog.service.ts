import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

interface CatalogRow {
  category_id: string;
  category_name: string;
  category_slug: string;
  sort_order: number;
  product_id: string;
  sku: string | null;
  product_name: string;
  description: string | null;
  image_url: string | null;
  price: string;
  currency: string;
  is_available: boolean;
  available_quantity: number | null;
  preparation_minutes: number;
}

@Injectable()
export class CatalogService {
  constructor(private readonly databaseService: DatabaseService) {}

  async getCatalog(tenantCode: string, branchCode: string) {
    const branchResult = await this.databaseService.query<{
      tenant_code: string;
      tenant_name: string;
      branch_code: string;
      branch_name: string;
      timezone: string;
    }>(
      `
        select
          t.code as tenant_code,
          t.name as tenant_name,
          b.code as branch_code,
          b.name as branch_name,
          b.timezone
        from public.tenants t
        inner join public.branches b
          on b.tenant_id = t.id
        where t.code = $1
          and b.code = $2
          and t.status = 'ACTIVE'
          and b.status = 'ACTIVE'
        limit 1
      `,
      [tenantCode, branchCode],
    );

    const branch = branchResult.rows[0];

    if (!branch) {
      throw new NotFoundException(
        `Tenant or branch not found: ${tenantCode}/${branchCode}`,
      );
    }

    const productsResult = await this.databaseService.query<CatalogRow>(
      `
        select
          c.id::text as category_id,
          c.name as category_name,
          c.slug as category_slug,
          c.sort_order,

          p.id::text as product_id,
          p.sku,
          p.name as product_name,
          p.description,
          p.image_url,

          bp.price::text as price,
          bp.currency,
          bp.is_available,
          bp.available_quantity,
          bp.preparation_minutes

        from public.branch_products bp

        inner join public.products p
          on p.tenant_id = bp.tenant_id
         and p.id = bp.product_id

        inner join public.product_categories c
          on c.tenant_id = p.tenant_id
         and c.id = p.category_id

        where bp.tenant_id = (
          select id
          from public.tenants
          where code = $1
          limit 1
        )
          and bp.branch_id = (
            select id
            from public.branches
            where tenant_id = bp.tenant_id
              and code = $2
            limit 1
          )
          and p.active = true
          and c.active = true

        order by
          c.sort_order,
          c.name,
          p.name
      `,
      [tenantCode, branchCode],
    );

    const categories = new Map<
      string,
      {
        id: string;
        name: string;
        slug: string;
        sortOrder: number;
        products: Array<{
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
        }>;
      }
    >();

    for (const row of productsResult.rows) {
      if (!categories.has(row.category_id)) {
        categories.set(row.category_id, {
          id: row.category_id,
          name: row.category_name,
          slug: row.category_slug,
          sortOrder: row.sort_order,
          products: [],
        });
      }

      categories.get(row.category_id)!.products.push({
        id: row.product_id,
        sku: row.sku,
        name: row.product_name,
        description: row.description,
        imageUrl: row.image_url,
        price: Number(row.price),
        currency: row.currency,
        available: row.is_available,
        availableQuantity: row.available_quantity,
        preparationMinutes: row.preparation_minutes,
      });
    }

    return {
      tenant: {
        code: branch.tenant_code,
        name: branch.tenant_name,
      },
      branch: {
        code: branch.branch_code,
        name: branch.branch_name,
        timezone: branch.timezone,
      },
      categories: Array.from(categories.values()),
    };
  }
}
