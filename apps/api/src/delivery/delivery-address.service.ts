import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DatabaseService } from '../database/database.service';
import {
  GEO_PROVIDER,
  type GeoProvider,
} from './geo-provider';
import { GeoUsageMeterService } from './geo-usage-meter.service';
import type { GeoPoint } from './geo.types';
import type {
  DeliveryAddressAutocompleteInput,
  DeliveryAddressAutocompleteResponse,
  DeliveryAddressGeocodeInput,
  DeliveryAddressGeocodeResponse,
  DeliveryAddressResolveInput,
  DeliveryAddressResolveResponse,
} from './delivery-address.types';

interface DeliveryAddressBranchRow {
  tenant_code: string;
  branch_code: string;
  delivery_enabled: boolean;
  delivery_origin_latitude: string | null;
  delivery_origin_longitude: string | null;
}

interface DeliveryAddressBranchContext {
  tenantCode: string;
  branchCode: string;
  origin: GeoPoint | null;
}

interface DeliveryAddressLocale {
  languageCode: string;
  countryCode: string;
}

@Injectable()
export class DeliveryAddressService {
  constructor(
    private readonly databaseService: DatabaseService,

    private readonly configService: ConfigService,

    private readonly geoUsageMeter: GeoUsageMeterService,

    @Inject(GEO_PROVIDER)
    private readonly geoProvider: GeoProvider,
  ) {}

  async autocomplete(
    input: DeliveryAddressAutocompleteInput,
  ): Promise<DeliveryAddressAutocompleteResponse> {
    const tenantCode =
      this.requireCode(
        input.tenantCode,
        'tenantCode',
      );

    const branchCode =
      this.requireCode(
        input.branchCode,
        'branchCode',
      );

    const searchText =
      this.requireText(
        input.input,
        'input',
        3,
        256,
      );

    const branch =
      await this.requireDeliveryBranch(
        tenantCode,
        branchCode,
      );

    const locale =
      this.readLocale();

    const radiusMeters =
      this.readBiasRadiusMeters();

    const suggestions =
      await this.geoUsageMeter.measure({ tenantCode, provider: 'GOOGLE', operation: 'GEOCODE_SEARCH', cacheHit: false }, () => this.geoProvider.autocomplete({
        input: searchText,

        languageCode:
          locale.languageCode,

        regionCode:
          locale.countryCode,

        countryCode:
          locale.countryCode,

        locationBias:
          branch.origin &&
          radiusMeters > 0
            ? {
                center:
                  branch.origin,

                radiusMeters,
              }
            : undefined,
      }));

    return {
      tenant:
        branch.tenantCode,

      branch:
        branch.branchCode,

      suggestions,
    };
  }

  async resolve(
    input: DeliveryAddressResolveInput,
  ): Promise<DeliveryAddressResolveResponse> {
    const tenantCode =
      this.requireCode(
        input.tenantCode,
        'tenantCode',
      );

    const branchCode =
      this.requireCode(
        input.branchCode,
        'branchCode',
      );

    const placeId =
      this.requirePlaceId(
        input.placeId,
      );

    const branch =
      await this.requireDeliveryBranch(
        tenantCode,
        branchCode,
      );

    const locale =
      this.readLocale();

    const location =
      await this.geoUsageMeter.measure({ tenantCode, provider: 'GOOGLE', operation: 'GEOCODE_RESOLVE', cacheHit: false }, () => this.geoProvider.resolvePlace({
        placeId,

        languageCode:
          locale.languageCode,

        regionCode:
          locale.countryCode,
      }));

    return {
      tenant:
        branch.tenantCode,

      branch:
        branch.branchCode,

      location,
    };
  }

  async geocode(
    input: DeliveryAddressGeocodeInput,
  ): Promise<DeliveryAddressGeocodeResponse> {
    const tenantCode =
      this.requireCode(
        input.tenantCode,
        'tenantCode',
      );

    const branchCode =
      this.requireCode(
        input.branchCode,
        'branchCode',
      );

    const address =
      this.requireText(
        input.address,
        'address',
        3,
        512,
      );

    const branch =
      await this.requireDeliveryBranch(
        tenantCode,
        branchCode,
      );

    const locale =
      this.readLocale();

    const location =
      await this.geoUsageMeter.measure({ tenantCode, provider: 'GOOGLE', operation: 'GEOCODE_FORWARD', cacheHit: false }, () => this.geoProvider.geocodeAddress({
        address,

        languageCode:
          locale.languageCode,

        regionCode:
          locale.countryCode,
      }));

    return {
      tenant:
        branch.tenantCode,

      branch:
        branch.branchCode,

      location,
    };
  }

  private async requireDeliveryBranch(
    tenantCode: string,
    branchCode: string,
  ): Promise<DeliveryAddressBranchContext> {
    const result =
      await this.databaseService.query<DeliveryAddressBranchRow>(
        `
          select
            t.code as tenant_code,
            b.code as branch_code,
            b.delivery_enabled,
            b.delivery_origin_latitude::text,
            b.delivery_origin_longitude::text

          from public.tenants t

          inner join public.branches b
            on b.tenant_id = t.id

          where t.code = $1
            and b.code = $2

          limit 1
        `,
        [
          tenantCode,
          branchCode,
        ],
      );

    if (result.rows.length === 0) {
      throw new NotFoundException(
        'Delivery branch was not found',
      );
    }

    const row =
      result.rows[0];

    if (!row.delivery_enabled) {
      throw new ServiceUnavailableException(
        'Delivery is not enabled for this branch',
      );
    }

    return {
      tenantCode:
        row.tenant_code,

      branchCode:
        row.branch_code,

      origin:
        this.parseBranchOrigin(
          row.delivery_origin_latitude,
          row.delivery_origin_longitude,
        ),
    };
  }

  private parseBranchOrigin(
    latitudeValue: string | null,
    longitudeValue: string | null,
  ): GeoPoint | null {
    if (
      latitudeValue === null &&
      longitudeValue === null
    ) {
      return null;
    }

    if (
      latitudeValue === null ||
      longitudeValue === null
    ) {
      throw new ServiceUnavailableException(
        'Delivery branch origin coordinates are incomplete',
      );
    }

    const latitude =
      Number(latitudeValue);

    const longitude =
      Number(longitudeValue);

    if (
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new ServiceUnavailableException(
        'Delivery branch origin coordinates are invalid',
      );
    }

    return {
      latitude,
      longitude,
    };
  }

  private readLocale():
    DeliveryAddressLocale {
    const languageCode =
      this.readLanguageCode();

    const countryCode =
      this.readCountryCode();

    return {
      languageCode,
      countryCode,
    };
  }

  private readLanguageCode(): string {
    const value =
      this.configService
        .get<string>(
          'FLASH_GEO_DEFAULT_LANGUAGE_CODE',
        )
        ?.trim() ||
      'es-BO';

    if (
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(
        value,
      )
    ) {
      throw new ServiceUnavailableException(
        'FLASH_GEO_DEFAULT_LANGUAGE_CODE is invalid',
      );
    }

    return value;
  }

  private readCountryCode(): string {
    const value =
      this.configService
        .get<string>(
          'FLASH_GEO_DEFAULT_COUNTRY_CODE',
        )
        ?.trim()
        .toUpperCase() ||
      'BO';

    if (!/^[A-Z]{2}$/.test(value)) {
      throw new ServiceUnavailableException(
        'FLASH_GEO_DEFAULT_COUNTRY_CODE must contain two letters',
      );
    }

    return value;
  }

  private readBiasRadiusMeters(): number {
    const configuredValue =
      this.configService.get<
        string | number
      >(
        'FLASH_GEO_AUTOCOMPLETE_BIAS_RADIUS_METERS',
      );

    const text =
      configuredValue === undefined ||
      configuredValue === null
        ? '25000'
        : String(
            configuredValue,
          ).trim();

    const radius =
      Number(text);

    if (
      !Number.isFinite(radius) ||
      radius < 0 ||
      radius > 50_000
    ) {
      throw new ServiceUnavailableException(
        'FLASH_GEO_AUTOCOMPLETE_BIAS_RADIUS_METERS must be between 0 and 50000',
      );
    }

    return radius;
  }

  private requireCode(
    value: unknown,
    label: string,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${label} must be a string`,
      );
    }

    const normalized =
      value.trim();

    if (
      normalized.length === 0 ||
      normalized.length > 64 ||
      !/^[A-Za-z0-9_-]+$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `${label} is invalid`,
      );
    }

    return normalized;
  }

  private requirePlaceId(
    value: unknown,
  ): string {
    const placeId =
      this.requireText(
        value,
        'placeId',
        1,
        512,
      );

    if (
      /[\u0000-\u0020\u007f]/.test(
        placeId,
      )
    ) {
      throw new BadRequestException(
        'placeId is invalid',
      );
    }

    return placeId;
  }

  private requireText(
    value: unknown,
    label: string,
    minLength: number,
    maxLength: number,
  ): string {
    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${label} must be a string`,
      );
    }

    const normalized =
      value.trim();

    if (
      normalized.length < minLength ||
      normalized.length > maxLength
    ) {
      throw new BadRequestException(
        `${label} length is invalid`,
      );
    }

    if (
      /[\u0000-\u001f\u007f]/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `${label} contains invalid characters`,
      );
    }

    return normalized;
  }
}