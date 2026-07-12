import type { Request, Response } from 'express';
import type { Container } from '../core/container/Container.ts';
import { TOKENS } from '../core/tokens.ts';
import { formatPrometheusText } from './metricsFormat.ts';

/** GET /health — liveness only: is the process up? Unchanged since v2.0.0. */
export function createHealthHandler() {
  return (_req: Request, res: Response): void => {
    res.status(200).json({
      status: 'ok',
      uptime: process.uptime(),
    });
  };
}

interface ReadinessCheck {
  status: 'ok' | 'error' | 'not-configured';
  error?: string;
}

/**
 * GET /ready — is the process able to actually serve traffic? Distinct
 * from /health: a process can be "up" (liveness) while an optional backend
 * it depends on is unreachable (not "ready"). Probes the AAI-036 optional
 * Postgres/Redis backends only when configured — resolve(), not get(), so
 * an unconfigured deployment (v2.0.0's in-memory-only mode) reports ready
 * without ever touching a network connection it was never given.
 */
export function createReadinessHandler(container: Container) {
  return async (_req: Request, res: Response): Promise<void> => {
    const checks: Record<string, ReadinessCheck> = {};

    const postgresPool = container.resolve(TOKENS.postgresPool);
    if (postgresPool) {
      checks.postgres = await probe(() => postgresPool.query('SELECT 1'));
    } else {
      checks.postgres = { status: 'not-configured' };
    }

    const redisClient = container.resolve(TOKENS.redisClient);
    if (redisClient) {
      checks.redis = await probe(() => redisClient.exists('__readiness-check__'));
    } else {
      checks.redis = { status: 'not-configured' };
    }

    const ready = Object.values(checks).every((check) => check.status !== 'error');

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not-ready',
      checks,
    });
  };
}

async function probe(fn: () => Promise<unknown>): Promise<ReadinessCheck> {
  try {
    await fn();
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * GET /diagnostics — the pre-existing version/pluginCount/uptime body,
 * extended (additively — no field removed or renamed) with a snapshot of
 * every cross-cutting hub's own getDiagnostics(). Reuses those hubs
 * exactly as built; this endpoint adds no new counters of its own.
 */
export function createDiagnosticsHandler(container: Container, frameworkVersion: string) {
  return (_req: Request, res: Response): void => {
    const security = container.get(TOKENS.security).getDiagnostics();

    res.status(200).json({
      version: frameworkVersion,
      pluginCount: container.get(TOKENS.pluginRegistry).list().length,
      uptime: process.uptime(),
      diagnostics: {
        observability: container.get(TOKENS.observability).getDiagnostics(),
        tracing: container.get(TOKENS.tracing).getDiagnostics(),
        metrics: container.get(TOKENS.metrics).getDiagnostics(),
        streaming: container.get(TOKENS.streaming).getDiagnostics(),
        workflows: container.get(TOKENS.workflows).getDiagnostics(),
        security: {
          ...security,
          // RegExp serializes to "{}" through JSON.stringify — report the
          // pattern source instead so the response is actually readable.
          policy: {
            ...security.policy,
            blockedPatterns: security.policy.blockedPatterns.map((pattern) => pattern.source),
          },
        },
      },
    });
  };
}

/**
 * GET /metrics — Prometheus scrape endpoint. Calls export() (not
 * collect()): a scrape is exactly the "push to every registered exporter"
 * moment MetricsRegistry.export() already models, so the console exporter
 * (and any plugin-contributed exporter) see every scrape too.
 */
export function createMetricsHandler(container: Container) {
  return (_req: Request, res: Response): void => {
    const snapshot = container.get(TOKENS.metrics).export();
    res.status(200).type('text/plain; version=0.0.4; charset=utf-8').send(formatPrometheusText(snapshot));
  };
}
