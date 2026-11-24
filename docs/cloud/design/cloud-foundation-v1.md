# Cloud Foundation V1

Two private ESM packages, Node.js 24, pnpm 11.21.0, TypeScript strict mode.

`external app → @flashcommerce/cloud-sdk → @flashcommerce/cloud-contracts`

Contracts have no dependencies. SDK depends only on the contracts workspace package. TypeScript is the only external development dependency. Build contracts before SDK and type validation (`pnpm build`, `pnpm typecheck`, `pnpm test:unit`, `pnpm test:contract`, `pnpm check:imports`). No dependency on the existing FlashCommerce application.

## Public boundaries

- TenantContext carries tenant, request and correlation identifiers per request.
- Identity models a user or service; trusted authentication remains an external responsibility.
- AuthorizationPort returns an explicit allow/deny decision. Mock grants default to deny.
- EntitlementsPort supplies tenant features and limits. The client checks feature access; limits are descriptive, not quota enforcement.
- ModuleManifest declares a module version, contract version, capabilities and required capability identifiers. Registry resolution is deferred to G3.
- ProductCatalogPort and FlashLivePort expose read-only product/session lookups. Products intentionally omit pricing, stock, checkout and fulfillment business logic.
- CloudError exposes stable error codes and optional request correlation; error messages contain no payloads.
- CloudEventV1 is a discriminated union of versioned session-started and product-updated events. No event broker or delivery service exists here.

## Isolation and mocks

CloudClient checks identity tenant, authorization, entitlements tenant and feature, then the returned object's tenant. Mocks resolve records by tenant plus identifier, return defensive copies and return NOT_FOUND for other tenants. There is no network transport, database, persistent service, payment integration or authentication implementation. Mock authorization grants are fixture-wide; they are unsuitable for production authorization.

Contracts are compile-time interfaces. Runtime checks currently cover tenant context and tenant boundaries only. Untrusted JSON requires future schema validation, including timestamps, manifests, IDs, statuses and events. Applications must derive tenant and identity from trusted authentication, never directly from user input.

## Versioning

Contract version `1.0` is independent of package version `0.1.0`. Event type suffix `.v1` and eventVersion `1` identify payload compatibility. Additive compatible fields may be optional; incompatible payload changes require a new event discriminator and major contract version. Packages remain private until publication is separately approved.

## G3 proposal (not authorized or implemented)

Design Cloud Core composition and Module Registry using these public contracts. Define manifest runtime schemas, duplicate and incompatible version rejection, capability dependency resolution and cycle detection, and tenant-aware module enablement. Begin with an in-memory registry and tests. Authentication integration, persistence, event transport, real commercial adapters and deployment each require separate scope and authorization.
