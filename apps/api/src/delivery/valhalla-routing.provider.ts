import { Injectable } from '@nestjs/common';
import type {
  GeoCapabilities,
  GeoMapMatchInput,
  GeoMapMatchResult,
  GeoPoint,
  GeoRouteInput,
  GeoRouteMatrixEntry,
  GeoRouteMatrixInput,
  GeoRouteMatrixResult,
  RouteResult,
} from './geo.types';
import type { RoutingProvider } from './routing-provider';

type JsonRecord = Record<string, unknown>;

interface ValhallaRuntimeConfig {
  baseUrl: string;
  timeoutMs: number;
}

@Injectable()
export class ValhallaRoutingProvider implements RoutingProvider {
  readonly name = 'VALHALLA' as const;

  getCapabilities(): GeoCapabilities {
    return {
      routing: {
        route: true,
        matrix: true,
        mapMatch: true,
        trafficAware: false,
      },
      geocoding: {
        search: false,
        resolve: false,
        forward: false,
        reverse: false,
      },
    };
  }

  async computeRoute(
    input: GeoRouteInput,
  ): Promise<RouteResult> {
    this.assertPoint(
      input.origin,
      'origin',
    );

    this.assertPoint(
      input.destination,
      'destination',
    );

    const response =
      await this.postJson(
        '/route',
        {
          locations: [
            this.toValhallaPoint(input.origin),
            this.toValhallaPoint(input.destination),
          ],
          costing: 'auto',
          units: 'kilometers',
        },
      );

    const root =
      this.requireRecord(
        response,
        'route response',
      );

    const trip =
      this.requireRecord(
        root.trip,
        'trip',
      );

    const summary =
      this.requireRecord(
        trip.summary,
        'trip.summary',
      );

    const lengthKm =
      this.requireFiniteNumber(
        summary.length,
        'trip.summary.length',
      );

    const durationSeconds =
      this.requireFiniteNumber(
        summary.time,
        'trip.summary.time',
      );

    const shape =
      this.requireTripShape(
        trip,
        'trip',
      );

    return {
      provider: 'VALHALLA',
      distanceMeters:
        Math.round(lengthKm * 1000),
      durationSeconds:
        Math.round(durationSeconds),
      trafficDurationSeconds: null,
      geometry: shape,
      geometryFormat: 'POLYLINE6',
      mapCompatibility: 'OPEN_STANDARD_ONLY',
      calculatedAt:
        new Date().toISOString(),
      expiresAt: null,
      metadata: {},
    };
  }

  async computeMatrix(
    input: GeoRouteMatrixInput,
  ): Promise<GeoRouteMatrixResult> {
    if (input.origins.length < 1) {
      throw new Error(
        'VALHALLA_MATRIX_ORIGINS_REQUIRED',
      );
    }

    if (input.destinations.length < 1) {
      throw new Error(
        'VALHALLA_MATRIX_DESTINATIONS_REQUIRED',
      );
    }

    input.origins.forEach(
      (point, index) =>
        this.assertPoint(
          point,
          `origins[${index}]`,
        ),
    );

    input.destinations.forEach(
      (point, index) =>
        this.assertPoint(
          point,
          `destinations[${index}]`,
        ),
    );

    const response =
      await this.postJson(
        '/sources_to_targets',
        {
          sources:
            input.origins.map(
              (point) =>
                this.toValhallaPoint(point),
            ),
          targets:
            input.destinations.map(
              (point) =>
                this.toValhallaPoint(point),
            ),
          costing: 'auto',
          units: 'kilometers',
        },
      );

    const root =
      this.requireRecord(
        response,
        'matrix response',
      );

    const rows =
      this.requireArray(
        root.sources_to_targets,
        'sources_to_targets',
      );

    if (
      rows.length !==
      input.origins.length
    ) {
      throw new Error(
        'VALHALLA_MATRIX_ROW_COUNT_MISMATCH',
      );
    }

    const entries:
      GeoRouteMatrixEntry[] =
        [];

    rows.forEach(
      (rowValue, originIndex) => {
        const row =
          this.requireArray(
            rowValue,
            `sources_to_targets[${originIndex}]`,
          );

        if (
          row.length !==
          input.destinations.length
        ) {
          throw new Error(
            'VALHALLA_MATRIX_COLUMN_COUNT_MISMATCH',
          );
        }

        row.forEach(
          (
            entryValue,
            destinationIndex,
          ) => {
            const entry =
              this.requireRecord(
                entryValue,
                `sources_to_targets[${originIndex}][${destinationIndex}]`,
              );

            const distanceKm =
              this.requireFiniteNumber(
                entry.distance,
                'matrix distance',
              );

            const durationSeconds =
              this.requireFiniteNumber(
                entry.time,
                'matrix time',
              );

            entries.push({
              originIndex,
              destinationIndex,
              distanceMeters:
                Math.round(
                  distanceKm * 1000,
                ),
              durationSeconds:
                Math.round(
                  durationSeconds,
                ),
            });
          },
        );
      },
    );

    return {
      provider: 'VALHALLA',
      entries,
      calculatedAt:
        new Date().toISOString(),
      expiresAt: null,
      metadata: {},
    };
  }

  async matchTrace(
    input: GeoMapMatchInput,
  ): Promise<GeoMapMatchResult> {
    if (input.trace.length < 2) {
      throw new Error(
        'VALHALLA_MAP_MATCH_TRACE_REQUIRES_AT_LEAST_TWO_POINTS',
      );
    }

    input.trace.forEach(
      (point, index) =>
        this.assertPoint(
          point,
          `trace[${index}]`,
        ),
    );

    const response =
      await this.postJson(
        '/trace_route',
        {
          shape:
            input.trace.map(
              (point) =>
                this.toValhallaPoint(point),
            ),
          costing: 'auto',
          shape_match: 'map_snap',
          units: 'kilometers',
        },
      );

    const root =
      this.requireRecord(
        response,
        'trace response',
      );

    const trip =
      this.requireRecord(
        root.trip,
        'trip',
      );

    const shape =
      this.requireTripShape(
        trip,
        'trip',
      );

    return {
      provider: 'VALHALLA',
      geometry: shape,
      geometryFormat: 'POLYLINE6',
      mapCompatibility: 'OPEN_STANDARD_ONLY',
      calculatedAt:
        new Date().toISOString(),
      metadata: {},
    };
  }

  private getRuntimeConfig():
    ValhallaRuntimeConfig {
    const baseUrlRaw =
      process.env.VALHALLA_BASE_URL;

    const baseUrl =
      baseUrlRaw?.trim().replace(
        /\/+$/,
        '',
      ) ?? '';

    if (!baseUrl) {
      throw new Error(
        'VALHALLA_BASE_URL_REQUIRED',
      );
    }

    let parsedUrl: URL;

    try {
      parsedUrl =
        new URL(baseUrl);
    } catch {
      throw new Error(
        'VALHALLA_BASE_URL_INVALID',
      );
    }

    const isHttps =
      parsedUrl.protocol === 'https:';

    const isLocalHttp =
      parsedUrl.protocol === 'http:' &&
      (
        parsedUrl.hostname ===
          'localhost' ||
        parsedUrl.hostname ===
          '127.0.0.1' ||
        parsedUrl.hostname ===
          '::1'
      );

    if (!isHttps && !isLocalHttp) {
      throw new Error(
        'VALHALLA_BASE_URL_PROTOCOL_NOT_ALLOWED',
      );
    }

    const timeoutRaw =
      process.env.VALHALLA_TIMEOUT_MS
        ?.trim();

    const timeoutMs =
      timeoutRaw
        ? Number(timeoutRaw)
        : 8000;

    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1000 ||
      timeoutMs > 30000
    ) {
      throw new Error(
        'VALHALLA_TIMEOUT_MS_INVALID',
      );
    }

    return {
      baseUrl,
      timeoutMs,
    };
  }

  private async postJson(
    path: string,
    payload: JsonRecord,
  ): Promise<unknown> {
    const config =
      this.getRuntimeConfig();

    const controller =
      new AbortController();

    const timeoutHandle =
      setTimeout(
        () =>
          controller.abort(),
        config.timeoutMs,
      );

    let response;

    try {
      response =
        await fetch(
          `${config.baseUrl}${path}`,
          {
            method: 'POST',
            headers: {
              'content-type':
                'application/json',
            },
            body:
              JSON.stringify(payload),
            signal:
              controller.signal,
          },
        );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === 'AbortError'
      ) {
        throw new Error(
          'VALHALLA_TIMEOUT',
        );
      }

      throw new Error(
        'VALHALLA_PROVIDER_NETWORK_ERROR',
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
      throw new Error(
        `VALHALLA_HTTP_STATUS_${response.status}`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new Error(
        'VALHALLA_RESPONSE_INVALID_JSON',
      );
    }
  }

  private toValhallaPoint(
    point: GeoPoint,
  ): {
    lat: number;
    lon: number;
  } {
    return {
      lat: point.latitude,
      lon: point.longitude,
    };
  }

  private assertPoint(
    point: GeoPoint,
    fieldName: string,
  ): void {
    if (
      !Number.isFinite(
        point.latitude,
      ) ||
      !Number.isFinite(
        point.longitude,
      ) ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      point.longitude < -180 ||
      point.longitude > 180
    ) {
      throw new Error(
        `VALHALLA_INVALID_POINT_${fieldName}`,
      );
    }
  }

  private requireTripShape(
    trip: JsonRecord,
    fieldName: string,
  ): string {
    const legs =
      this.requireArray(
        trip.legs,
        `${fieldName}.legs`,
      );

    if (legs.length < 1) {
      throw new Error(
        'VALHALLA_ROUTE_LEGS_REQUIRED',
      );
    }

    const firstLeg =
      this.requireRecord(
        legs[0],
        `${fieldName}.legs[0]`,
      );

    return this.requireString(
      firstLeg.shape,
      `${fieldName}.legs[0].shape`,
    );
  }

  private requireRecord(
    value: unknown,
    fieldName: string,
  ): JsonRecord {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new Error(
        `VALHALLA_RESPONSE_FIELD_INVALID_${fieldName}`,
      );
    }

    return value as JsonRecord;
  }

  private requireArray(
    value: unknown,
    fieldName: string,
  ): unknown[] {
    if (!Array.isArray(value)) {
      throw new Error(
        `VALHALLA_RESPONSE_FIELD_INVALID_${fieldName}`,
      );
    }

    return value;
  }

  private requireFiniteNumber(
    value: unknown,
    fieldName: string,
  ): number {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value)
    ) {
      throw new Error(
        `VALHALLA_RESPONSE_FIELD_INVALID_${fieldName}`,
      );
    }

    return value;
  }

  private requireString(
    value: unknown,
    fieldName: string,
  ): string {
    if (
      typeof value !== 'string' ||
      value.length < 1
    ) {
      throw new Error(
        `VALHALLA_RESPONSE_FIELD_INVALID_${fieldName}`,
      );
    }

    return value;
  }
}
