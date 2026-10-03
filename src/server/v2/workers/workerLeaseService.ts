import os from "os";
import cuid from "cuid";
import type { V2Database } from "../db";

export type WorkerLeaseRecord = {
  workerId: string;
  status: "idle" | "busy" | "offline";
  activeJobId?: string;
  capabilities: Record<string, unknown>;
  startedAt: string;
  lastHeartbeat: string;
  leaseExpiresAt?: string;
};

export class WorkerLeaseService {
  constructor(private db: V2Database) { }

  public defaultWorkerId(): string {
    return process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
  }

  public async heartbeat(input: {
    workerId?: string;
    status?: "idle" | "busy" | "offline";
    activeJobId?: string | null;
    capabilities?: Record<string, unknown>;
    leaseMs?: number;
  } = {}): Promise<WorkerLeaseRecord> {
    const workerId = input.workerId || this.defaultWorkerId();
    const leaseMs = input.leaseMs || 120000;
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const rows = await this.db.query<any>(
      `INSERT INTO worker_leases (
        worker_id, status, active_job_id, capabilities, started_at, last_heartbeat, lease_expires_at
      ) VALUES ($1,$2,$3,$4,now(),now(),$5)
      ON CONFLICT (worker_id) DO UPDATE SET
        status = EXCLUDED.status,
        active_job_id = EXCLUDED.active_job_id,
        capabilities = EXCLUDED.capabilities,
        last_heartbeat = now(),
        lease_expires_at = EXCLUDED.lease_expires_at
      RETURNING *`,
      [
        workerId,
        input.status || (input.activeJobId ? "busy" : "idle"),
        input.activeJobId || null,
        JSON.stringify(input.capabilities || { render: true, ffmpeg: true, remotion: true }),
        expires,
      ],
    );
    return this.map(rows[0]);
  }

  public async claimNextJob(options: {
    workerId?: string;
    capabilities?: Record<string, unknown>;
    maxConcurrentRenders?: number;
    leaseMs?: number;
  } = {}): Promise<{ claimed: boolean; jobId?: string; queueDepth: number; activeRenders: number }> {
    const maxConcurrentRenders = Math.max(1, options.maxConcurrentRenders || 1);
    const activeRows = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM worker_leases
       WHERE status = 'busy' AND lease_expires_at > now()`,
    );
    const activeRenders = Number(activeRows[0]?.count || 0);
    const queuedRows = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'",
    );
    const queueDepth = Number(queuedRows[0]?.count || 0);
    if (activeRenders >= maxConcurrentRenders) {
      await this.heartbeat({
        workerId: options.workerId,
        status: "idle",
        capabilities: options.capabilities,
        leaseMs: options.leaseMs,
      });
      return { claimed: false, queueDepth, activeRenders };
    }

    const workerId = options.workerId || this.defaultWorkerId();
    const leaseExpires = new Date(Date.now() + (options.leaseMs || 120000)).toISOString();
    const rows = await this.db.query<{ id: string }>(
      `WITH candidate AS (
         SELECT id FROM jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE jobs
       SET status = 'preparing',
           progress = GREATEST(progress, 5),
           current_stage = 'Preparing',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
       WHERE id IN (SELECT id FROM candidate)
       RETURNING id`,
    );

    if (!rows[0]) {
      await this.heartbeat({ workerId, status: "idle", capabilities: options.capabilities, leaseMs: options.leaseMs });
      return { claimed: false, queueDepth, activeRenders };
    }

    await this.heartbeat({
      workerId,
      status: "busy",
      activeJobId: rows[0].id,
      capabilities: options.capabilities,
      leaseMs: options.leaseMs,
    });
    return { claimed: true, jobId: rows[0].id, queueDepth, activeRenders: activeRenders + 1 };
  }

  public async claimJob(jobId: string, options: {
    workerId?: string;
    capabilities?: Record<string, unknown>;
    maxConcurrentRenders?: number;
    leaseMs?: number;
  } = {}): Promise<{ claimed: boolean; jobId?: string; queueDepth: number; activeRenders: number; reason?: string }> {
    const maxConcurrentRenders = Math.max(1, options.maxConcurrentRenders || 1);
    const activeRows = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM worker_leases
       WHERE status = 'busy' AND lease_expires_at > now()`,
    );
    const activeRenders = Number(activeRows[0]?.count || 0);
    const queuedRows = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'",
    );
    const queueDepth = Number(queuedRows[0]?.count || 0);
    if (activeRenders >= maxConcurrentRenders) {
      return { claimed: false, queueDepth, activeRenders, reason: "backpressure" };
    }
    const rows = await this.db.query<{ id: string }>(
      `UPDATE jobs
       SET status = 'preparing',
           progress = GREATEST(progress, 5),
           current_stage = 'Preparing',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
       WHERE id = $1 AND status = 'queued'
       RETURNING id`,
      [jobId],
    );
    if (!rows[0]) {
      return { claimed: false, queueDepth, activeRenders, reason: "not_queued" };
    }
    await this.heartbeat({
      workerId: options.workerId,
      status: "busy",
      activeJobId: rows[0].id,
      capabilities: options.capabilities,
      leaseMs: options.leaseMs,
    });
    return { claimed: true, jobId: rows[0].id, queueDepth, activeRenders: activeRenders + 1 };
  }

  public async release(workerId: string): Promise<void> {
    await this.heartbeat({ workerId, status: "idle", activeJobId: null });
  }

  public async recoverExpiredLeases(): Promise<{ recoveredJobs: string[] }> {
    const rows = await this.db.query<{ active_job_id: string }>(
      `UPDATE worker_leases
       SET status = 'offline', active_job_id = null
       WHERE lease_expires_at < now() AND status = 'busy'
       RETURNING active_job_id`,
    );
    const recoveredJobs = rows.map((row) => row.active_job_id).filter(Boolean);
    if (recoveredJobs.length > 0) {
      await this.db.query(
        `UPDATE jobs
         SET status = 'queued',
             current_stage = 'Queued after expired worker lease',
             updated_at = now()
         WHERE id = ANY($1) AND status NOT IN ('ready','needs_review','failed','canceled')`,
        [recoveredJobs],
      );
    }
    return { recoveredJobs };
  }

  public async getObservability(): Promise<{
    queueDepth: number;
    activeWorkers: number;
    activeRenders: number;
    workers: WorkerLeaseRecord[];
    averageGenerationTimeMs: number | null;
    recentStageBottleneck?: string;
  }> {
    const [queuedRows, workerRows, avgRows, bottleneckRows] = await Promise.all([
      this.db.query<{ count: string }>("SELECT count(*)::text AS count FROM jobs WHERE status = 'queued'"),
      this.db.query<any>("SELECT * FROM worker_leases ORDER BY last_heartbeat DESC LIMIT 20"),
      this.db.query<{ avg_ms: string | null }>(
        `SELECT avg(EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000)::text AS avg_ms
         FROM jobs WHERE completed_at IS NOT NULL AND started_at IS NOT NULL`,
      ),
      this.db.query<{ key: string; avg_ms: string }>(
        `SELECT key, avg((value::text)::numeric)::text AS avg_ms
         FROM jobs, jsonb_each(stage_timings)
         WHERE jsonb_typeof(stage_timings) = 'object'
         GROUP BY key
         ORDER BY avg((value::text)::numeric) DESC
         LIMIT 1`,
      ).catch(() => []),
    ]);
    const workers = workerRows.map((row) => this.map(row));
    return {
      queueDepth: Number(queuedRows[0]?.count || 0),
      activeWorkers: workers.filter((worker) => worker.status !== "offline").length,
      activeRenders: workers.filter((worker) => worker.status === "busy").length,
      workers,
      averageGenerationTimeMs: avgRows[0]?.avg_ms ? Math.round(Number(avgRows[0].avg_ms)) : null,
      recentStageBottleneck: bottleneckRows[0]?.key,
    };
  }

  private map(row: any): WorkerLeaseRecord {
    return {
      workerId: row.worker_id || cuid(),
      status: row.status || "idle",
      activeJobId: row.active_job_id || undefined,
      capabilities: typeof row.capabilities === "string" ? JSON.parse(row.capabilities) : row.capabilities || {},
      startedAt: new Date(row.started_at || Date.now()).toISOString(),
      lastHeartbeat: new Date(row.last_heartbeat || Date.now()).toISOString(),
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at).toISOString() : undefined,
    };
  }
}
