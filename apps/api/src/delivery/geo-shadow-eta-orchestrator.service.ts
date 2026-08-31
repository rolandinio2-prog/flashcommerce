import { Injectable } from '@nestjs/common';
import type { RouteResult } from './geo.types';
import { GeoShadowEtaCalibrationService } from './geo-shadow-eta-calibration.service';
import type {
  GeoShadowEtaFailedSample,
  GeoShadowEtaSuccessSample,
} from './geo-shadow-eta.types';
import type {
  GeoShadowEtaOrchestratorInput,
  GeoShadowEtaOrchestratorResult,
} from './geo-shadow-eta-orchestrator.types';
import { GeoUsageMeterService } from './geo-usage-meter.service';
import { GoogleRoutingProvider } from './google-routing.provider';
import { ValhallaRoutingProvider } from './valhalla-routing.provider';

const SHADOW_ROUTE_ERROR_CODE =
  'GEO_SHADOW_ROUTE_FAILED';

@Injectable()
export class GeoShadowEtaOrchestratorService {
  constructor(
    private readonly googleRoutingProvider:
      GoogleRoutingProvider,
    private readonly valhallaRoutingProvider:
      ValhallaRoutingProvider,
    private readonly geoUsageMeter:
      GeoUsageMeterService,
    private readonly calibrationService:
      GeoShadowEtaCalibrationService,
  ) {}

  async compareRoute(
    input: GeoShadowEtaOrchestratorInput,
  ): Promise<GeoShadowEtaOrchestratorResult> {
    let referenceLatencyMs:
      number | null =
        null;

    const referenceRoute =
      await this.geoUsageMeter.measure(
        this.createUsageInput(
          input,
          'GOOGLE',
        ),
        async () => {
          const startedAt =
            Date.now();

          try {
            return await this.googleRoutingProvider.computeRoute(
              input.route,
            );
          } finally {
            referenceLatencyMs =
              this.elapsedMilliseconds(
                startedAt,
              );
          }
        },
      );

    const referenceSample =
      this.successSample(
        'GOOGLE',
        referenceRoute,
        referenceLatencyMs,
      );

    let shadowLatencyMs:
      number | null =
        null;

    let shadowRoute:
      RouteResult;

    try {
      shadowRoute =
        await this.geoUsageMeter.measure(
          this.createUsageInput(
            input,
            'VALHALLA',
          ),
          async () => {
            const startedAt =
              Date.now();

            try {
              return await this.valhallaRoutingProvider.computeRoute(
                input.route,
              );
            } finally {
              shadowLatencyMs =
                this.elapsedMilliseconds(
                  startedAt,
                );
            }
          },
        );
    } catch {
      const shadowFailure =
        this.failedShadowSample(
          shadowLatencyMs,
        );

      return {
        referenceRoute,
        comparison:
          this.calibrationService.compare({
            reference:
              referenceSample,
            shadow:
              shadowFailure,
          }),
      };
    }

    return {
      referenceRoute,
      comparison:
        this.calibrationService.compare({
          reference:
            referenceSample,
          shadow:
            this.successSample(
              'VALHALLA',
              shadowRoute,
              shadowLatencyMs,
            ),
        }),
    };
  }

  private createUsageInput(
    input: GeoShadowEtaOrchestratorInput,
    provider: 'GOOGLE' | 'VALHALLA',
  ): {
    tenantId?: string;
    tenantCode?: string;
    provider: 'GOOGLE' | 'VALHALLA';
    operation: 'ROUTE';
    cacheHit: false;
  } {
    return {
      tenantId:
        input.tenantId,
      tenantCode:
        input.tenantCode,
      provider,
      operation: 'ROUTE',
      cacheHit: false,
    };
  }

  private successSample(
    provider: 'GOOGLE' | 'VALHALLA',
    route: RouteResult,
    latencyMs: number | null,
  ): GeoShadowEtaSuccessSample {
    return {
      provider,
      status: 'SUCCESS',
      distanceMeters:
        route.distanceMeters,
      durationSeconds:
        route.durationSeconds,
      latencyMs,
    };
  }

  private failedShadowSample(
    latencyMs: number | null,
  ): GeoShadowEtaFailedSample {
    return {
      provider: 'VALHALLA',
      status: 'FAILED',
      distanceMeters: null,
      durationSeconds: null,
      latencyMs,
      errorCode:
        SHADOW_ROUTE_ERROR_CODE,
    };
  }

  private elapsedMilliseconds(
    startedAt: number,
  ): number {
    return Math.max(
      0,
      Date.now() - startedAt,
    );
  }
}
