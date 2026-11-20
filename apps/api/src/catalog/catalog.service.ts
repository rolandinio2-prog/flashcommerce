import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

interface CatalogRow {
  has_garnishes: boolean;
  garnish_parent_id: string | null;
  garnish_label: string | null;
  garnish_image_url: string | null;
  garnish_sort_order: number;
  category_id: string;
  category_name: string;
  category_slug: string;
  sort_order: number;
  has_presentations: boolean;
  presentation_parent_id: string | null;
  presentation_label: string | null;
  presentation_sort_order: number;
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

  private requireCode(value: string | undefined): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) {
      throw new BadRequestException('A valid commerce and branch identifier is required');
    }
    return value;
  }

  async getBranches(tenantCode: string | undefined) {
    const tenant = this.requireCode(tenantCode);
    const result = await this.databaseService.query<{
      tenant_code: string; tenant_name: string; branch_code: string; branch_name: string;
    }>(`
      select t.code as tenant_code, t.name as tenant_name,
             b.code as branch_code, b.name as branch_name
      from public.tenants t
      inner join public.branches b on b.tenant_id = t.id
      where t.code = $1 and t.status = 'ACTIVE' and b.status = 'ACTIVE'
      order by b.name, b.code
    `, [tenant]);
    if (!result.rows.length) throw new NotFoundException('Commerce unavailable');
    return {
      tenant: { code: result.rows[0].tenant_code, name: result.rows[0].tenant_name },
      branches: result.rows.map(row => ({ code: row.branch_code, name: row.branch_name })),
    };
  }

  async getCatalog(tenantCode: string | undefined, branchCode: string | undefined) {
    tenantCode = this.requireCode(tenantCode);
    branchCode = this.requireCode(branchCode);
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
          false as has_garnishes,
          p.garnish_parent_id::text,p.garnish_label,p.garnish_image_url,p.garnish_sort_order,
          exists(select 1 from public.products child join public.branch_products child_bp on child_bp.tenant_id=child.tenant_id and child_bp.product_id=child.id and child_bp.branch_id=bp.branch_id where child.tenant_id=p.tenant_id and child.presentation_parent_id=p.id) as has_presentations,
          p.presentation_parent_id::text,
          p.presentation_label,
          p.presentation_sort_order,
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
          hasPresentations: boolean;
          hasGarnishes: boolean;
          garnishParentId: string | null;
          garnishLabel: string | null;
          garnishImageUrl: string | null;
          garnishSortOrder: number;

        presentationParentId: string | null;
          presentationLabel: string | null;
          presentationSortOrder: number;
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
        hasPresentations: row.has_presentations,
        hasGarnishes: row.has_garnishes,
        garnishParentId: row.garnish_parent_id,
        garnishLabel: row.garnish_label,
        garnishImageUrl: row.garnish_image_url,
        garnishSortOrder: row.garnish_sort_order,
        presentationParentId: row.presentation_parent_id,
        presentationLabel: row.presentation_label,
        presentationSortOrder: row.presentation_sort_order,
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
