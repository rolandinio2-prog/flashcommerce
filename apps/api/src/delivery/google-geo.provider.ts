import { requestGoogleIpv4 } from './google-http';
import { readableAddress } from './readable-address';
import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { GeoProvider } from './geo-provider';
import type {
  GeoAutocompleteInput,
  GeoAutocompleteSuggestion,
  GeoGeocodeAddressInput,
  GeoPoint,
  GeoResolvedLocation,
  GeoResolvePlaceInput,
  GeoRouteInput,
  GeoRouteResult,
} from './geo.types';

const GOOGLE_AUTOCOMPLETE_URL =
  'https://places.googleapis.com/v1/places:autocomplete';

const GOOGLE_GEOCODE_ADDRESS_BASE_URL =
  'https://geocode.googleapis.com/v4/geocode/address/';

const GOOGLE_GEOCODE_PLACE_BASE_URL =
  'https://geocode.googleapis.com/v4/geocode/places/';

const GOOGLE_COMPUTE_ROUTES_URL =
  'https://routes.googleapis.com/directions/v2:computeRoutes';

const AUTOCOMPLETE_FIELD_MASK = [
  'suggestions.placePrediction.placeId',
  'suggestions.placePrediction.text.text',
  'suggestions.placePrediction.structuredFormat.mainText.text',
  'suggestions.placePrediction.structuredFormat.secondaryText.text',
].join(',');

const GEOCODE_ADDRESS_FIELD_MASK = [
  'results.placeId',
  'results.formattedAddress',
  'results.addressComponents',
  'results.location',
  'results.types',
  'results.granularity',
].join(',');

const GEOCODE_PLACE_FIELD_MASK = [
  'placeId',
  'formattedAddress',
  'addressComponents',
  'location',
  'types',
  'granularity',
].join(',');

const ROUTE_FIELD_MASK = [
  'routes.distanceMeters',
  'routes.duration',
  'routes.polyline.encodedPolyline',
].join(',');

interface GoogleGeoConfiguration {
  apiKey: string;
  requestTimeoutMs: number;
}

type UnknownRecord =
  Record<string, unknown>;

@Injectable()
export class GoogleGeoProvider implements GeoProvider {
  readonly name = 'GOOGLE';

  constructor(
    private readonly configService: ConfigService,
  ) {}

  async autocomplete(
    input: GeoAutocompleteInput,
  ): Promise<GeoAutocompleteSuggestion[]> {
    const searchText =
      this.requireText(
        input.input,
        'Geo autocomplete input',
        256,
      );

    const languageCode =
      this.normalizeOptionalLanguageCode(
        input.languageCode,
      );

    const regionCode =
      this.normalizeOptionalRegionCode(
        input.regionCode,
        'Geo regionCode',
      );

    const countryCode =
      this.normalizeOptionalRegionCode(
        input.countryCode,
        'Geo countryCode',
      );

    const body: UnknownRecord = {
      input: searchText,
      includeQueryPredictions: false,
    };

    if (languageCode) {
      body.languageCode = languageCode;
    }

    if (regionCode) {
      body.regionCode =
        regionCode.toLowerCase();
    }

    if (countryCode) {
      body.includedRegionCodes = [
        countryCode.toLowerCase(),
      ];
    }

    if (input.locationBias) {
      const center =
        this.requirePoint(
          input.locationBias.center,
          'Geo autocomplete locationBias.center',
        );

      const radius =
        this.requireRadiusMeters(
          input.locationBias.radiusMeters,
        );

      body.locationBias = {
        circle: {
          center,
          radius,
        },
      };
    }

    const payload =
      await this.requestJson(
        GOOGLE_AUTOCOMPLETE_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        AUTOCOMPLETE_FIELD_MASK,
        'Google Places Autocomplete',
      );

    const root =
      this.requireRecord(
        payload,
        'Google Places Autocomplete',
      );

    if (root.suggestions === undefined) {
      return [];
    }

    if (!Array.isArray(root.suggestions)) {
      throw new BadGatewayException(
        'Google Places Autocomplete returned invalid data',
      );
    }

    const suggestions:
      GeoAutocompleteSuggestion[] = [];

    for (const rawSuggestion of root.suggestions) {
      const suggestion =
        this.requireRecord(
          rawSuggestion,
          'Google Places Autocomplete suggestion',
        );

      if (
        suggestion.placePrediction ===
        undefined
      ) {
        continue;
      }

      const prediction =
        this.requireRecord(
          suggestion.placePrediction,
          'Google Places Autocomplete prediction',
        );

      const placeId =
        this.requireProviderString(
          prediction.placeId,
          'Google Places Autocomplete placeId',
        );

      const textObject =
        this.requireRecord(
          prediction.text,
          'Google Places Autocomplete text',
        );

      const text =
        this.requireProviderString(
          textObject.text,
          'Google Places Autocomplete text',
        );

      const structuredFormat =
        this.optionalRecord(
          prediction.structuredFormat,
        );

      const mainText =
        this.readNestedOptionalText(
          structuredFormat,
          'mainText',
        );

      const secondaryText =
        this.readNestedOptionalText(
          structuredFormat,
          'secondaryText',
        );

      suggestions.push({
        placeId,
        text,
        mainText,
        secondaryText,
      });
    }

    return suggestions;
  }

  async resolvePlace(
    input: GeoResolvePlaceInput,
  ): Promise<GeoResolvedLocation> {
    const placeId =
      this.requirePlaceId(
        input.placeId,
      );

    const url =
      new URL(
        GOOGLE_GEOCODE_PLACE_BASE_URL +
          encodeURIComponent(placeId),
      );

    this.applyLocaleQuery(
      url,
      input.languageCode,
      input.regionCode,
    );

    const payload =
      await this.requestJson(
        url.toString(),
        {
          method: 'GET',
        },
        GEOCODE_PLACE_FIELD_MASK,
        'Google place geocoding',
      );

    const result =
      this.requireRecord(
        payload,
        'Google place geocoding',
      );

    return this.parseResolvedLocation(
      result,
      'Google place geocoding',
    );
  }

  async geocodeAddress(
    input: GeoGeocodeAddressInput,
  ): Promise<GeoResolvedLocation | null> {
    const address =
      this.requireText(
        input.address,
        'Geo address',
        512,
      );

    const url =
      new URL(
        GOOGLE_GEOCODE_ADDRESS_BASE_URL +
          encodeURIComponent(address),
      );

    this.applyLocaleQuery(
      url,
      input.languageCode,
      input.regionCode,
    );

    const payload =
      await this.requestJson(
        url.toString(),
        {
          method: 'GET',
        },
        GEOCODE_ADDRESS_FIELD_MASK,
        'Google address geocoding',
      );

    const root =
      this.requireRecord(
        payload,
        'Google address geocoding',
      );

    if (root.results === undefined) {
      return null;
    }

    if (!Array.isArray(root.results)) {
      throw new BadGatewayException(
        'Google address geocoding returned invalid data',
      );
    }

    if (root.results.length === 0) {
      return null;
    }

    const firstResult =
      this.requireRecord(
        root.results[0],
        'Google address geocoding result',
      );

    return this.parseResolvedLocation(
      firstResult,
      'Google address geocoding',
    );
  }

  async reverseGeocode(input: { location: GeoPoint; languageCode?: string; regionCode?: string }): Promise<GeoResolvedLocation | null> {
    const point = this.requirePoint(input.location, 'Geo reverse location');
    const url = new URL('https://geocode.googleapis.com/v4/geocode/location');
    url.searchParams.set('location.latitude', String(point.latitude));
    url.searchParams.set('location.longitude', String(point.longitude));
    this.applyLocaleQuery(url, input.languageCode, input.regionCode);
    const payload = await this.requestJson(url.toString(), { method: 'GET' }, GEOCODE_ADDRESS_FIELD_MASK, 'Google reverse geocoding');
    const root = this.requireRecord(payload, 'Google reverse geocoding');
    if (root.results === undefined) return null;
    if (!Array.isArray(root.results)) throw new BadGatewayException('Google reverse geocoding returned invalid data');
    if (root.results.length === 0) return null;
    return this.parseResolvedLocation(this.requireRecord(root.results[0], 'Google reverse result'), 'Google reverse geocoding');
  }

  async calculateRoute(
    input: GeoRouteInput,
  ): Promise<GeoRouteResult> {
    const origin =
      this.requirePoint(
        input.origin,
        'Geo route origin',
      );

    const destination =
      this.requirePoint(
        input.destination,
        'Geo route destination',
      );

    const payload =
      await this.requestJson(
        GOOGLE_COMPUTE_ROUTES_URL,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            origin: {
              location: {
                latLng: origin,
              },
            },

            destination: {
              location: {
                latLng: destination,
              },
            },

            travelMode: 'DRIVE',
            routingPreference:
              'TRAFFIC_AWARE',

            computeAlternativeRoutes: false,
          }),
        },
        ROUTE_FIELD_MASK,
        'Google Routes',
      );

    const root =
      this.requireRecord(
        payload,
        'Google Routes',
      );

    if (
      !Array.isArray(root.routes) ||
      root.routes.length === 0
    ) {
      throw new BadGatewayException(
        'Google Routes returned no route',
      );
    }

    const route =
      this.requireRecord(
        root.routes[0],
        'Google Routes route',
      );

    const distanceMeters =
      route.distanceMeters;

    if (
      typeof distanceMeters !== 'number' ||
      !Number.isSafeInteger(
        distanceMeters,
      ) ||
      distanceMeters < 0
    ) {
      throw new BadGatewayException(
        'Google Routes returned invalid distance',
      );
    }

    const durationSeconds =
      this.parseDurationSeconds(
        route.duration,
      );

    const polyline =
      this.requireRecord(
        route.polyline,
        'Google Routes polyline',
      );

    const encodedPolyline =
      this.requireText(
        polyline.encodedPolyline,
        'Google Routes encoded polyline',
        100_000,
      );

    return {
      distanceMeters,
      durationSeconds,
      encodedPolyline,
    };
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    fieldMask: string,
    operation: string,
  ): Promise<unknown> {
    const configuration =
      this.getConfiguration();

    const headers =
      new Headers(init.headers);

    headers.set(
      'X-Goog-Api-Key',
      configuration.apiKey,
    );

    headers.set(
      'X-Goog-FieldMask',
      fieldMask,
    );

    let response: Response;

    try {
      response =
        await requestGoogleIpv4(
          url,
          {
            ...init,
            headers,

            signal:
              AbortSignal.timeout(
                configuration.requestTimeoutMs,
              ),

            redirect: 'error',
          },
        );
    } catch (error) {
      if (this.isTimeoutError(error)) {
        throw new GatewayTimeoutException(
          `${operation} timed out`,
        );
      }

      throw new BadGatewayException(
        `${operation} request failed`,
      );
    }

    let responseText: string;

    try {
      responseText =
        await response.text();
    } catch {
      throw new BadGatewayException(
        `${operation} response could not be read`,
      );
    }

    if (!response.ok) {
      if (
        response.status === 429 ||
        response.status >= 500
      ) {
        throw new ServiceUnavailableException(
          `${operation} is temporarily unavailable`,
        );
      }

      throw new BadGatewayException(
        `${operation} was rejected by Google`,
      );
    }

    if (
      responseText.trim().length === 0
    ) {
      throw new BadGatewayException(
        `${operation} returned an empty response`,
      );
    }

    try {
      return JSON.parse(
        responseText,
      ) as unknown;
    } catch {
      throw new BadGatewayException(
        `${operation} returned invalid JSON`,
      );
    }
  }

  private getConfiguration():
    GoogleGeoConfiguration {
    const apiKey =
      this.configService
        .get<string>(
          'FLASH_GEO_GOOGLE_API_KEY',
        );

    if (
      typeof apiKey !== 'string' ||
      apiKey.trim().length === 0
    ) {
      throw new ServiceUnavailableException(
        'FLASH_GEO_GOOGLE_API_KEY is not configured',
      );
    }

    const configuredTimeout =
      this.configService.get<
        string | number
      >(
        'FLASH_GEO_REQUEST_TIMEOUT_MS',
      );

    const timeoutText =
      configuredTimeout === undefined ||
      configuredTimeout === null
        ? '8000'
        : String(
            configuredTimeout,
          ).trim();

    const requestTimeoutMs =
      Number(timeoutText);

    if (
      !Number.isInteger(
        requestTimeoutMs,
      ) ||
      requestTimeoutMs < 1_000 ||
      requestTimeoutMs > 30_000
    ) {
      throw new ServiceUnavailableException(
        'FLASH_GEO_REQUEST_TIMEOUT_MS must be between 1000 and 30000',
      );
    }

    return {
      apiKey: apiKey.trim(),
      requestTimeoutMs,
    };
  }

  private applyLocaleQuery(
    url: URL,
    languageCodeInput?: string,
    regionCodeInput?: string,
  ): void {
    const languageCode =
      this.normalizeOptionalLanguageCode(
        languageCodeInput,
      );

    const regionCode =
      this.normalizeOptionalRegionCode(
        regionCodeInput,
        'Geo regionCode',
      );

    if (languageCode) {
      url.searchParams.set(
        'languageCode',
        languageCode,
      );
    }

    if (regionCode) {
      url.searchParams.set(
        'regionCode',
        regionCode.toLowerCase(),
      );
    }
  }

  private parseResolvedLocation(
    result: UnknownRecord,
    operation: string,
  ): GeoResolvedLocation {
    const placeId =
      this.requireProviderString(
        result.placeId,
        `${operation} placeId`,
      );

    const readable = readableAddress(result.addressComponents);
    // Keep validating the provider contract, but never display postal/plus codes.
    this.requireProviderString(result.formattedAddress, `${operation} formattedAddress`);


    const locationRecord =
      this.requireRecord(
        result.location,
        `${operation} location`,
      );

    const location =
      this.parseProviderPoint(
        locationRecord,
        `${operation} location`,
      );

    return {
      placeId,
      formattedAddress: readable.text,
      location,
      requiresMapConfirmation: !readable.hasDetail || result.granularity === 'APPROXIMATE' || !Array.isArray(result.types) ||
        !result.types.some(type => ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest', 'intersection'].includes(String(type))),
    };
  }

  private parseProviderPoint(
    value: UnknownRecord,
    operation: string,
  ): GeoPoint {
    const latitude =
      value.latitude;

    const longitude =
      value.longitude;

    if (
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new BadGatewayException(
        `${operation} returned invalid coordinates`,
      );
    }

    return {
      latitude,
      longitude,
    };
  }

  private parseDurationSeconds(
    value: unknown,
  ): number {
    if (typeof value !== 'string') {
      throw new BadGatewayException(
        'Google Routes returned invalid duration',
      );
    }

    const match =
      /^([0-9]+(?:\.[0-9]+)?)s$/.exec(
        value.trim(),
      );

    if (!match) {
      throw new BadGatewayException(
        'Google Routes returned invalid duration',
      );
    }

    const seconds =
      Number(match[1]);

    if (
      !Number.isFinite(seconds) ||
      seconds < 0
    ) {
      throw new BadGatewayException(
        'Google Routes returned invalid duration',
      );
    }

    return Math.ceil(seconds);
  }

  private requirePoint(
    value: GeoPoint,
    label: string,
  ): GeoPoint {
    if (
      value === null ||
      typeof value !== 'object'
    ) {
      throw new BadRequestException(
        `${label} is required`,
      );
    }

    const latitude =
      value.latitude;

    const longitude =
      value.longitude;

    if (
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90
    ) {
      throw new BadRequestException(
        `${label}.latitude must be between -90 and 90`,
      );
    }

    if (
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      throw new BadRequestException(
        `${label}.longitude must be between -180 and 180`,
      );
    }

    return {
      latitude,
      longitude,
    };
  }

  private requireRadiusMeters(
    value: number,
  ): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 50_000
    ) {
      throw new BadRequestException(
        'Geo autocomplete radiusMeters must be between 0 and 50000',
      );
    }

    return value;
  }

  private requirePlaceId(
    value: unknown,
  ): string {
    const placeId =
      this.requireText(
        value,
        'Geo placeId',
        512,
      );

    if (
      /[\u0000-\u0020\u007f]/.test(
        placeId,
      )
    ) {
      throw new BadRequestException(
        'Geo placeId is invalid',
      );
    }

    return placeId;
  }

  private requireText(
    value: unknown,
    label: string,
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
      normalized.length === 0 ||
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

  private normalizeOptionalLanguageCode(
    value: string | undefined,
  ): string | undefined {
    if (
      value === undefined ||
      value === null
    ) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(
        'Geo languageCode must be a string',
      );
    }

    const normalized =
      value.trim();

    if (normalized.length === 0) {
      return undefined;
    }

    if (
      !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        'Geo languageCode is invalid',
      );
    }

    return normalized;
  }

  private normalizeOptionalRegionCode(
    value: string | undefined,
    label: string,
  ): string | undefined {
    if (
      value === undefined ||
      value === null
    ) {
      return undefined;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(
        `${label} must be a string`,
      );
    }

    const normalized =
      value.trim();

    if (normalized.length === 0) {
      return undefined;
    }

    if (
      !/^[A-Za-z]{2}$/.test(
        normalized,
      )
    ) {
      throw new BadRequestException(
        `${label} must contain two letters`,
      );
    }

    return normalized;
  }

  private requireRecord(
    value: unknown,
    operation: string,
  ): UnknownRecord {
    const record =
      this.optionalRecord(value);

    if (!record) {
      throw new BadGatewayException(
        `${operation} returned invalid data`,
      );
    }

    return record;
  }

  private optionalRecord(
    value: unknown,
  ): UnknownRecord | null {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      return null;
    }

    return value as UnknownRecord;
  }

  private requireProviderString(
    value: unknown,
    label: string,
  ): string {
    if (typeof value !== 'string') {
      throw new BadGatewayException(
        `${label} is invalid`,
      );
    }

    const normalized =
      value.trim();

    if (normalized.length === 0) {
      throw new BadGatewayException(
        `${label} is invalid`,
      );
    }

    return normalized;
  }

  private readNestedOptionalText(
    parent: UnknownRecord | null,
    key: string,
  ): string | null {
    if (!parent) {
      return null;
    }

    const nested =
      this.optionalRecord(
        parent[key],
      );

    if (!nested) {
      return null;
    }

    if (typeof nested.text !== 'string') {
      return null;
    }

    const normalized =
      nested.text.trim();

    return normalized.length > 0
      ? normalized
      : null;
  }

  private isTimeoutError(
    error: unknown,
  ): boolean {
    return (
      error instanceof Error &&
      (
        error.name === 'TimeoutError' ||
        error.name === 'AbortError'
      )
    );
  }
}
