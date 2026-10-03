import http from "http";
import crypto from "crypto";
import axios from "axios";
import express from "express";
import type {
  NextFunction,
  Request as ExpressRequest,
  Response as ExpressResponse,
} from "express";
import path from "path";
import { ShortCreator } from "../short-creator/ShortCreator";
import { APIRouter } from "./routers/rest";
import { MCPRouter } from "./routers/mcp";
import { logger } from "../logger";
import { Config } from "../config";
import { V2Database } from "./v2/db";
import { JobService } from "./v2/jobs";
import { createV2InternalRouter, createV2PublicRouter } from "./v2/routes";
import { SystemHealthService } from "./v2/system/systemHealthService";
import { AuthService } from "./v2/auth/authService";
import { ApiTokenService } from "./v2/auth/apiTokenService";
import { cleanupTemporaryArtifacts } from "./v2/storage/storagePolicy";
import { resolveTrustedProxy } from "./v2/system/trustedProxy";
import { WorkerLeaseService } from "./v2/workers/workerLeaseService";

export class Server {
  private app: express.Application;
  private config: Config;
  private systemHealth?: SystemHealthService;
  private shutdownHooks: Array<() => Promise<void> | void> = [];

  constructor(
    config: Config,
    shortCreator: ShortCreator,
    v2Database?: V2Database,
    jobService?: JobService,
  ) {
    this.config = config;
    this.app = express();
    this.app.disable("x-powered-by");

    // Behind nginx or Cloudflare the browser's real protocol and host arrive
    // only as X-Forwarded-* headers. They are spoofable by anyone who can reach
    // the app directly, so they are honoured only when the operator declared a
    // proxy via TRUSTED_PROXY. Unset means "ignore them", which is what a
    // localhost installation wants.
    const trustedProxy = resolveTrustedProxy(process.env.TRUSTED_PROXY);
    this.app.set("trust proxy", trustedProxy.expressSetting);
    if (trustedProxy.enabled) {
      logger.info({ trustedProxy: trustedProxy.description }, "Trusted proxy mode enabled");
    }

    this.app.use(express.json({ limit: "2mb" }));
    this.app.use((req, res, next) => {
      const headerRequestId = req.headers["x-request-id"];
      const requestId =
        typeof headerRequestId === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(headerRequestId)
          ? headerRequestId
          : crypto.randomUUID();
      res.locals.requestId = requestId;
      res.setHeader("X-Request-ID", requestId);
      req.setTimeout(this.config.requestTimeoutMs);
      next();
    });

    if (v2Database) {
      this.systemHealth = new SystemHealthService(v2Database, config);
    }

    // Web Security Headers Middleware
    this.app.use((req, res, next) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: http: https:; media-src 'self' blob: data: http: https:;",
      );
      next();
    });

    // Liveness & Readiness Endpoints
    this.app.get("/health", (req: ExpressRequest, res: ExpressResponse) => {
      res.status(200).json({ status: "ok" });
    });

    this.app.get("/health/live", (req: ExpressRequest, res: ExpressResponse) => {
      res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
    });

    this.app.get("/health/ready", async (req: ExpressRequest, res: ExpressResponse) => {
      if (this.systemHealth) {
        const readiness = await this.systemHealth.checkReadiness();
        res.status(readiness.ready ? 200 : 503).json(readiness);
      } else {
        res.status(200).json({ ready: true, message: "Server ready" });
      }
    });

    const authService = v2Database ? new AuthService(v2Database) : undefined;
    const apiTokenService = v2Database ? new ApiTokenService(v2Database) : undefined;
    const apiRouter = new APIRouter(config, shortCreator, authService, apiTokenService);
    const mcpRouter = new MCPRouter(shortCreator);
    this.app.use("/api", apiRouter.router);
    this.app.use("/mcp", mcpRouter.router);

    if (process.env.V2_ENABLED === "true") {
      this.app.use(
        "/internal/v1",
        createV2InternalRouter(config, shortCreator, jobService, v2Database),
      );
      if (v2Database && jobService && config.serviceRole === "app") {
        this.app.use("/api/v2", createV2PublicRouter(config, v2Database, jobService));
        this.registerShutdownHook(() => v2Database.close());
        // Recover stale jobs/publications on startup
        this.systemHealth?.recoverStaleJobs().catch((err) => {
          logger.warn({ err }, "Stale job recovery encountered non-fatal error");
        });
        this.scheduleQueuedJobSweep(v2Database);
        this.scheduleJobWatchdog(v2Database);
        cleanupTemporaryArtifacts(config)
          .then((result) => {
            if (result.deleted > 0) {
              logger.info(result, "Cleaned old temporary artifacts");
            }
          })
          .catch((err) => logger.warn({ err }, "Temporary artifact cleanup failed"));
      }
    }

    // Serve static files from the UI build
    this.app.use(express.static(path.join(__dirname, "../../dist/ui")));
    this.app.use(
      "/static",
      express.static(path.join(__dirname, "../../static")),
    );

    // Serve the React app for all other routes (must be last)
    this.app.use((req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/internal") || req.path.startsWith("/mcp")) {
        res.status(404).json({
          error: {
            code: "not_found",
            message: "Endpoint not found.",
            requestId: res.locals.requestId,
            retryable: false,
          },
        });
        return;
      }
      next();
    });
    this.app.get("*", (req: ExpressRequest, res: ExpressResponse) => {
      res.sendFile(path.join(__dirname, "../../dist/ui/index.html"));
    });
    this.app.use((err: unknown, req: ExpressRequest, res: ExpressResponse, _next: NextFunction) => {
      const message = err instanceof Error ? err.message : "Unexpected server error.";
      logger.error({ err, requestId: res.locals.requestId, path: req.path }, "Request failed");
      res.status(500).json({
        error: {
          code: "internal_error",
          message: this.config.environment === "production" ? "Internal server error." : message,
          requestId: res.locals.requestId,
          retryable: true,
        },
      });
    });
  }

  /**
   * Jobs sitting in `queued` have no dispatcher after a restart: the only
   * drivers are the creation-time orchestration webhook and the in-memory
   * backpressure retry timer, neither of which survives a process restart.
   * Once the render worker answers its health check, replay the internal
   * start request for each stranded job in FIFO order. The start route's
   * existing claim/backpressure path keeps concurrency safe.
   */
  private scheduleQueuedJobSweep(v2Database: V2Database): void {
    const config = this.config;
    const timer = setTimeout(() => {
      void (async () => {
        const deadline = Date.now() + 5 * 60 * 1000;
        for (; ;) {
          try {
            await axios.get(`${config.renderWorkerBaseUrl}/health`, { timeout: 5000 });
            break;
          } catch {
            if (Date.now() >= deadline) return;
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
        const rows = await v2Database.query<{ id: string }>(
          "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC",
        );
        for (const row of rows) {
          await axios
            .post(
              `${config.appInternalBaseUrl}/internal/v1/jobs/${row.id}/start`,
              {},
              {
                timeout: config.webhookTimeoutMs,
                headers: { "x-internal-token": config.internalServiceToken },
              },
            )
            .catch((err) =>
              logger.warn({ err, jobId: row.id }, "Queued-job restart dispatch failed"),
            );
        }
        if (rows.length > 0) {
          logger.info({ count: rows.length }, "Re-dispatched queued jobs stranded by restart");
        }
      })().catch((err) => logger.warn({ err }, "Queued-job restart sweep failed"));
    }, 15000);
    timer.unref?.();
  }

  /**
   * Recurring stranded-job watchdog. The boot-time sweep only covers the
   * restart case; a worker that loses contact while the app keeps running
   * leaves jobs frozen mid-stage forever. Every 60s this:
   *   1. re-queues jobs whose worker lease expired,
   *   2. re-queues mid-stage jobs with no progress update for 10 minutes and
   *      no live claimant (bounded to 2 automatic re-queues, recorded in
   *      job_events so an operator can see the lineage),
   *   3. fails jobs that exhausted their re-queues with an honest technical
   *      code instead of leaving them "working" forever,
   *   4. re-dispatches queued jobs when the render worker is healthy.
   */
  private scheduleJobWatchdog(v2Database: V2Database): void {
    const config = this.config;
    const STUCK_AFTER_MS = 10 * 60 * 1000;
    const MAX_AUTO_REQUEUES = 2;
    let ticking = false;
    const timer = setInterval(() => {
      if (ticking) return;
      ticking = true;
      void (async () => {
        await new WorkerLeaseService(v2Database).recoverExpiredLeases();

        const stranded = await v2Database.query<{ id: string }>(
          `UPDATE jobs
           SET status = 'queued',
               current_stage = 'Re-queued after worker silence',
               updated_at = now()
           WHERE status IN ('preparing','generating_content','searching_assets','generating_voice','generating_captions','rendering','finalizing')
             AND updated_at < now() - $1::interval
             AND NOT EXISTS (
               SELECT 1 FROM worker_leases w
               WHERE w.active_job_id = jobs.id AND w.lease_expires_at > now()
             )
             AND (
               SELECT count(*) FROM job_events e
               WHERE e.job_id = jobs.id AND e.technical_message = 'WATCHDOG_AUTO_REQUEUED'
             ) < $2
           RETURNING id`,
          [`${STUCK_AFTER_MS} milliseconds`, MAX_AUTO_REQUEUES],
        );
        for (const row of stranded) {
          await v2Database.query(
            `INSERT INTO job_events (job_id, status, progress, stage, message, technical_message)
             SELECT id, 'queued', progress, 'Re-queued', 'Re-queued automatically after the render worker stopped reporting progress.', 'WATCHDOG_AUTO_REQUEUED'
             FROM jobs WHERE id = $1`,
            [row.id],
          ).catch(() => undefined);
        }

        const exhausted = await v2Database.query<{ id: string }>(
          `UPDATE jobs
           SET status = 'failed',
               error = 'Production stalled repeatedly and could not be recovered automatically. Please retry.',
               technical_error = 'STALE_JOB_NO_PROGRESS',
               updated_at = now()
           WHERE status IN ('preparing','generating_content','searching_assets','generating_voice','generating_captions','rendering','finalizing')
             AND updated_at < now() - $1::interval
             AND NOT EXISTS (
               SELECT 1 FROM worker_leases w
               WHERE w.active_job_id = jobs.id AND w.lease_expires_at > now()
             )
             AND (
               SELECT count(*) FROM job_events e
               WHERE e.job_id = jobs.id AND e.technical_message = 'WATCHDOG_AUTO_REQUEUED'
             ) >= $2
           RETURNING id`,
          [`${STUCK_AFTER_MS} milliseconds`, MAX_AUTO_REQUEUES],
        );
        if (stranded.length || exhausted.length) {
          logger.info(
            { requeued: stranded.map((r) => r.id), failed: exhausted.map((r) => r.id) },
            "Job watchdog recovered stranded jobs",
          );
        }

        try {
          await axios.get(`${config.renderWorkerBaseUrl}/health`, { timeout: 5000 });
        } catch {
          return;
        }
        const queued = await v2Database.query<{ id: string }>(
          "SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 10",
        );
        for (const row of queued) {
          await axios
            .post(
              `${config.appInternalBaseUrl}/internal/v1/jobs/${row.id}/start`,
              {},
              {
                timeout: config.webhookTimeoutMs,
                headers: { "x-internal-token": config.internalServiceToken },
              },
            )
            .catch((err) =>
              logger.warn({ err, jobId: row.id }, "Watchdog queued-job dispatch failed"),
            );
        }
      })()
        .catch((err) => logger.warn({ err }, "Job watchdog tick failed"))
        .finally(() => {
          ticking = false;
        });
    }, 60000);
    timer.unref?.();
  }

  public registerShutdownHook(hook: () => Promise<void> | void): void {
    this.shutdownHooks.push(hook);
  }

  public start(): http.Server {
    const server = this.app.listen(this.config.port, this.config.bindHost, () => {
      logger.info(
        { host: this.config.bindHost, port: this.config.port, mcp: "/mcp", api: "/api" },
        "MCP and API server is running",
      );
      logger.info(
        `UI server is running on http://${this.config.bindHost}:${this.config.port}`,
      );
    });

    server.on("error", (error: Error) => {
      logger.error(error, "Error starting server");
    });

    // Graceful Shutdown
    let shuttingDown = false;
    const handleShutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, "Received shutdown signal, closing HTTP server gracefully...");
      server.close(async () => {
        for (const hook of this.shutdownHooks) {
          try {
            await hook();
          } catch (err) {
            logger.warn({ err }, "Shutdown hook failed");
          }
        }
        logger.info("HTTP server closed.");
        process.exit(0);
      });
      setTimeout(() => {
        logger.warn("Forced shutdown after timeout");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
    process.on("SIGINT", () => handleShutdown("SIGINT"));

    return server;
  }

  public getApp() {
    return this.app;
  }
}
