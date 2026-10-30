# Architecture

The workspace packages are `@sitebot/config`, `@sitebot/core`, `@sitebot/server`, `@sitebot/widget`, `@sitebot/react`, and `@sitebot/cli`.

- Config supplies schemas, validation, JSON Schema generation, locale catalogs, and a separate Node configuration loader.
- Core supplies providers, trusted prompt resolution, the bounded model loop, registered tool transports, permissions, approvals, session persistence, generic source provenance, telemetry, and streaming.
- Server supplies Next.js, Express, Fastify, Hono, Node, and fetch adapters around the same protocol handler.
- Widget supplies the custom element and localized chat UI; React supplies integration components.
- CLI supplies init, validate, dev, serve, and doctor.

Config imports no higher package. Core imports config. Server imports core and config. Widget and React may import config types and designated lightweight locale entries; they do not import core. Nothing imports CLI. Cross-package imports use public exports. Node filesystem, SQLite, PostgreSQL, Redis, safe HTTP, and stdio MCP constructors live behind Node entrypoints.

A request passes origin, authentication, size, rate, and budget checks. The engine resolves trusted instructions once for that incoming request, composes separate untrusted page context, restores trusted server history, and offers only eligible registered tools. Arguments and results are validated around an admitted handler invocation. Validated successful calls can publish staged sources. The loop streams a usable answer, an authorized suspension, or a localized explicit error, and persists conversation/checkpoint state.

Consumer code chooses all providers, model instructions, context loaders, tool schemas and implementations, storage, and deployment topology. No tool or context subsystem is discovered automatically. `core/src/sources` is generic framework infrastructure.

The neutral entry bundle has no Node imports. This is a dependency boundary check, not qualification of Ajv runtime code generation on restricted edge platforms. Hosts must validate their execution environment.
