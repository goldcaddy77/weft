import type { Engine } from '../../core/engine.ts';
import {
  createMetricsCollectorExporter,
  type MetricsCollector,
  type PrometheusExporter,
} from '../../observability/metrics.ts';
import type { AuthContext } from '../authentication.ts';
import { faultToHttpResponse } from '../fault-to-http.ts';
import { generateOpenApiDocument, type OpenApiSecuritySchemeName } from '../openapi.ts';
import { generateOpenRpcDocument } from '../openrpc.ts';
import { executeOperation, type OperationRegistry } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { FAULT_CODE_TO_HTTP_STATUS } from '../operation-fault.ts';
import {
  anonymousPrincipal,
  principalFromApiKey,
  principalFromJwtClaims,
  principalFromMutualTls,
  type Principal,
} from '../principal.ts';
import {
  createLiveOperationRegistry,
  createLiveRestBindings,
  type UnknownRestBinding,
} from '../rest-bindings.ts';
import {
  defaultShapeSuccess,
  errorResponse,
  jsonResponse,
  negotiatedResponse,
} from './response-helpers.ts';
import type { HandlerName } from './route-matching.ts';

/** Alias for `AuthContext` — kept local so handler-internal code reads naturally. */
type AuthenticatedRequestContext = AuthContext;

/**
 * Options bag passed to `handleRequest` by the HTTP server wrapper.
 *
 * Injects the resolved authentication context, custom metrics exporters, and
 * an optional override for the operation registry and REST bindings.  Omit
 * `operationRegistry` and `restBindings` together to use the live defaults.
 *
 * @example
 * ```ts
 * import { type HandlerOptions } from 'weft/server/handler';
 *
 * const options: HandlerOptions = {
 *   authContext: { method: 'public' },
 * };
 * void options;
 * ```
 */
export interface HandlerOptions {
  /**
   * Optional authenticated caller context injected by the HTTP server
   * wrapper. See `AuthContext` in `authentication.ts` for field documentation.
   */
  authContext?: AuthContext;
  /**
   * Optional {@link PrometheusExporter} used to produce the body of
   * `/v1/metrics`. When set, it takes precedence over `metricsCollector` —
   * this is the recommended plug point for projects that source metrics from
   * the OpenTelemetry SDK (e.g. via `@opentelemetry/exporter-prometheus`).
   */
  prometheusExporter?: PrometheusExporter;
  /**
   * Optional metrics collector for the /v1/metrics endpoint. Used when no
   * `prometheusExporter` is provided.
   *
   * @deprecated Prefer `prometheusExporter` — wrap your metrics source (OTel
   * or otherwise) in a {@link PrometheusExporter} and pass it there. This
   * field remains for projects still using the legacy `MetricsCollector`
   * path and has lower precedence if both are set.
   */
  metricsCollector?: MetricsCollector;
  /**
   * Operation registry for pipeline dispatch. Must be supplied together
   * with `restBindings` — a caller that overrides one but not the other
   * gets a mismatched configuration (custom bindings referencing a live
   * registry they weren't built against), which `handleRequest` rejects
   * at request time. Omit both to use the live defaults.
   */
  operationRegistry?: OperationRegistry;
  /**
   * REST bindings. A request whose method+path matches a binding routes
   * through the `executeOperation` pipeline. Must be supplied together
   * with `operationRegistry`. Omit both to use the live defaults.
   */
  restBindings?: ReadonlyArray<UnknownRestBinding>;
  /** OpenAPI security schemes supported by the live server configuration. */
  supportedAuthenticationSchemes?: ReadonlySet<OpenApiSecuritySchemeName>;
}

async function handleGetMetrics(
  prometheusExporter: PrometheusExporter | undefined,
  metricsCollector: MetricsCollector | undefined,
): Promise<Response> {
  const exporter = prometheusExporter ?? createMetricsCollectorExporter(metricsCollector);
  let body: string;
  try {
    body = await exporter.serialize();
  } catch (error) {
    console.error('PrometheusExporter.serialize() threw', { error });
    return new Response(JSON.stringify({ error: 'metrics exporter failed' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

export type RouteExecutionContext = {
  request: Request;
  engine: Engine;
  options: HandlerOptions | undefined;
};

export type RouteExecutor = (context: RouteExecutionContext) => Promise<Response>;

export const ROUTE_EXECUTORS: Record<HandlerName, RouteExecutor> = {
  healthCheck: async ({ request }) => negotiatedResponse(request, { status: 'ok' }),
  getMetrics: async ({ options }) =>
    handleGetMetrics(options?.prometheusExporter, options?.metricsCollector),
  openApiDocument: async ({ options }) =>
    jsonResponse(
      generateOpenApiDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(),
        ...(options?.restBindings !== undefined ? { restBindings: options.restBindings } : {}),
        ...(options?.supportedAuthenticationSchemes !== undefined
          ? { supportedSchemes: options.supportedAuthenticationSchemes }
          : {}),
      }),
    ),
  openRpcDocument: async ({ options }) =>
    jsonResponse(
      generateOpenRpcDocument({
        registry: options?.operationRegistry ?? defaultOperationRegistry(),
        transports: ['http', 'websocket'],
      }),
    ),
};

export async function dispatchViaExecuteOperation(
  request: Request,
  engine: Engine,
  binding: UnknownRestBinding,
  pathParams: Record<string, string>,
  registry: OperationRegistry,
  principal: Principal,
): Promise<Response> {
  let input: unknown;
  try {
    input = await binding.extractInput(request, pathParams);
  } catch (error) {
    if (isOperationFaultLike(error)) {
      return binding.shapeFault ? binding.shapeFault(error) : faultToHttpResponse(error);
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message, 400);
  }
  const result = await executeOperation(binding.operationName, input, {
    principal,
    engine,
    transport: 'http-rest',
    registry,
  });
  if (result.ok) {
    return binding.shapeSuccess
      ? binding.shapeSuccess(result.value, request)
      : defaultShapeSuccess(result.value, binding.success);
  }
  return binding.shapeFault ? binding.shapeFault(result.fault) : faultToHttpResponse(result.fault);
}

function hasRequiredFaultProperties(candidate: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(candidate, 'code') &&
    Object.hasOwn(candidate, 'message') &&
    Object.hasOwn(candidate, 'data')
  );
}

function readFaultProperties(
  candidate: Record<string, unknown>,
): { code: unknown; message: unknown; data: unknown } | null {
  try {
    return {
      code: candidate['code'],
      message: candidate['message'],
      data: candidate['data'],
    };
  } catch {
    return null;
  }
}

/**
 * Type guard that returns true if the value structurally resembles an
 * {@link OperationFault} (carries `code`, `message`, and `data` properties).
 *
 * Used by error handlers to decide whether a thrown value can be mapped to a
 * structured operation fault response, vs. needing to be wrapped in a generic
 * 500.
 *
 * @example Catch an unknown error and surface as a fault when it qualifies
 * ```ts
 * import { isOperationFaultLike } from 'weft/server/handler';
 *
 * try {
 *   // operation handler runs here
 * } catch (error) {
 *   if (isOperationFaultLike(error)) {
 *     // structured fault — pass through
 *   } else {
 *     // unknown — wrap as 500
 *   }
 * }
 * ```
 */
export function isOperationFaultLike(value: unknown): value is OperationFault {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  if (!hasRequiredFaultProperties(candidate)) {
    return false;
  }

  const fields = readFaultProperties(candidate);
  if (fields === null) return false;

  // `Object.hasOwn` (not `in`) so we don't accidentally promote a
  // foreign object whose `code` is `'__proto__'`, `'constructor'`,
  // or any other inherited property of `FAULT_CODE_TO_HTTP_STATUS`.
  return (
    typeof fields.code === 'string' &&
    Object.hasOwn(FAULT_CODE_TO_HTTP_STATUS, fields.code) &&
    typeof fields.message === 'string' &&
    typeof fields.data === 'object' &&
    fields.data !== null &&
    !Array.isArray(fields.data)
  );
}

/**
 * Convert the REST transport's `authContext` into a `Principal`. The
 * authenticator (`serve()`) only reports method + optional claims; this
 * shim bridges that into the richer `Principal` the pipeline expects.
 * Returns `anonymousPrincipal()` when no context is provided (public
 * request).
 *
 * @example
 * ```ts
 * import { authContextToPrincipal } from 'weft/server/handler';
 *
 * const principal = authContextToPrincipal({ method: 'api-key' });
 * console.log(principal.method); // 'api-key'
 * ```
 */
export function authContextToPrincipal(
  authContext: AuthenticatedRequestContext | undefined,
): Principal {
  if (authContext === undefined) return anonymousPrincipal();
  if (authContext.principal !== undefined) return authContext.principal;
  switch (authContext.method) {
    case 'jwt': {
      if (authContext.claims === undefined) {
        throw new Error(
          'authContextToPrincipal: jwt authContext reached the pipeline without claims — ' +
            'authenticator contract violation',
        );
      }
      return principalFromJwtClaims(authContext.claims);
    }
    case 'api-key':
      return principalFromApiKey({ subject: 'api-key-caller', scopes: [] });
    case 'mtls':
      return principalFromMutualTls({ subject: 'mtls-caller', scopes: [] });
    case 'public':
      return anonymousPrincipal();
  }
}

/**
 * Lazily-initialized live operation registry used as the default for
 * callers that don't pass one. The registry is stateless and can be
 * shared across all requests.
 */
let defaultOperationRegistryCache: OperationRegistry | undefined;

export function defaultOperationRegistry(): OperationRegistry {
  if (defaultOperationRegistryCache === undefined) {
    defaultOperationRegistryCache = createLiveOperationRegistry();
  }
  return defaultOperationRegistryCache;
}

let defaultRestBindingsCache: ReadonlyArray<UnknownRestBinding> | undefined;

export function defaultRestBindings(): ReadonlyArray<UnknownRestBinding> {
  if (defaultRestBindingsCache === undefined) {
    defaultRestBindingsCache = createLiveRestBindings();
  }
  return defaultRestBindingsCache;
}
