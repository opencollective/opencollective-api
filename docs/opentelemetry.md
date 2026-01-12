# OpenTelemetry

In the `development` environment (i.g. `process.env.NODE_ENV === 'development'`), the API is instrumented with OpenTelemetry when `OPENTELEMETRY_ENABLED=true`.

To collect and visualize traces, execute a collector, for example with [Jaeger](https://github.com/jaegertracing/jaeger):

```sh
docker run -d --name jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:1.39
```

View traces at http://localhost:16686.

## Configuration

The OpenTelemetry SDK reads standard environment variables. Common ones for local dev:

```sh
# Enable tracing in this API
OPENTELEMETRY_ENABLED=true

# Export traces to Jaeger OTLP/HTTP
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces

# Avoid 404s from Jaeger (it doesn't accept OTLP metrics)
OTEL_METRICS_EXPORTER=none

# Force sampling while debugging
OTEL_TRACES_SAMPLER=always_on

# Optional: increase verbosity
OTEL_LOG_LEVEL=debug

# Optional: override the service name (defaults to opencollective-api)
OTEL_SERVICE_NAME=opencollective-api
```

Notes:

- The SDK defaults to `http://localhost:4318/v1/traces` when no traces endpoint is set.
- If `OTEL_SERVICE_NAME` is not set, the bootstrap sets it to `opencollective-api`.
- Sequelize spans are enabled via `@opentelemetry/instrumentation-sequelize` in `server/open-telemetry.ts`.
