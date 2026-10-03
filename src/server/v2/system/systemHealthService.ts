import { Config } from "../../../config";
import { logger } from "../../../logger";
import { getProductInfo } from "../../../version";
import { V2Database } from "../db";
import { WorkerLeaseService } from "../workers/workerLeaseService";
import { checkStoragePolicy } from "../storage/storagePolicy";

export class SystemHealthService {
  constructor(
    private db: V2Database,
    private config: Config,
  ) { }

  public getProductDetails() {
    return getProductInfo();
  }

  public async checkLiveness(): Promise<{ status: "ok"; timestamp: string }> {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  public async checkReadiness(): Promise<{
    ready: boolean;
    checks: Record<string, boolean>;
    message: string;
    details: Record<string, unknown>;
  }> {
    const storage = await checkStoragePolicy(this.config);
    const runtimeConfigValid =
      typeof this.config.validateRuntimeConfig === "function"
        ? this.config.validateRuntimeConfig().valid
        : true;
    const checks: Record<string, boolean> = {
      config: runtimeConfigValid,
      storage: storage.ok,
      videosDir: storage.ok,
      postgres: false,
    };
    const details: Record<string, unknown> = {
      storage,
      databasePool:
        typeof this.db.getPoolState === "function"
          ? this.db.getPoolState()
          : { configured: this.db.enabled },
    };

    if (this.db.enabled) {
      const pgHealth = await this.db.health();
      checks.postgres = pgHealth.ok;
      details.postgres = pgHealth;
    } else {
      checks.postgres = true;
    }

    const ready = Object.values(checks).every(Boolean);

    return {
      ready,
      checks,
      message: ready ? "Application is ready to serve requests." : "Application is starting or degraded.",
      details,
    };
  }

  public async recoverStaleJobs(): Promise<{ recoveredJobsCount: number; recoveredPubsCount: number }> {
    if (!this.db.enabled) return { recoveredJobsCount: 0, recoveredPubsCount: 0 };

    let recoveredJobsCount = 0;
    let recoveredPubsCount = 0;

    try {
      // 1. Recover stale jobs left in 'rendering' or 'processing'
      const leaseRecovery = await new WorkerLeaseService(this.db).recoverExpiredLeases();
      recoveredJobsCount += leaseRecovery.recoveredJobs.length;

      const staleJobs = await this.db.query<{ id: string }>(
        `UPDATE jobs
         SET status = 'failed',
             error = 'Job interrupted by container restart.',
             technical_error = 'STALE_PROCESS_INTERRUPTED_ON_STARTUP',
             updated_at = now()
         WHERE status IN ('preparing','generating_content','searching_assets','generating_voice','generating_captions','rendering','finalizing')
         RETURNING id`,
      );
      recoveredJobsCount += staleJobs.length;
      if (recoveredJobsCount > 0) {
        logger.info({ recoveredJobsCount }, "Recovered stale interrupted jobs on startup");
      }

      // 2. Recover stale publications left in 'uploading'
      const stalePubs = await this.db.query<{ id: string }>(
        `UPDATE publications
         SET status = 'failed',
             last_error = 'Upload interrupted by container restart.',
             technical_error = 'STALE_UPLOAD_INTERRUPTED_ON_STARTUP',
             updated_at = now()
         WHERE status = 'uploading'
         RETURNING id`,
      );
      recoveredPubsCount = stalePubs.length;
      if (recoveredPubsCount > 0) {
        logger.info({ recoveredPubsCount }, "Recovered stale interrupted publications on startup");
      }

      // 3. Reset claimed scheduled publications back to pending
      await this.db.query(
        `UPDATE scheduled_publications
         SET status = 'pending', locked_at = null, locked_by = null, updated_at = now()
         WHERE status = 'claimed'`,
      );
    } catch (error) {
      logger.error({ error }, "Error executing stale job recovery");
    }

    return { recoveredJobsCount, recoveredPubsCount };
  }
}
