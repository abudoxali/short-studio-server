import express from "express";
import fs from "fs-extra";
import os from "os";
import path from "path";
import nock from "nock";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Config, REMOTE_ACCESS_REQUIRES_SECURE_SERVER_MODE } from "../../config";
import { ShortCreator } from "../../short-creator/ShortCreator";
import { Server } from "../server";
import { listVideoFiles, mergeMetadata, readMetadata, writeMetadata } from "../videoMetadata";
import { validatePexelsProvider } from "./health";
import {
  createV2InternalRouter,
  createV2PublicRouter,
  serializeMediaAssetForApi,
  serializeProductMediaForApi,
} from "./routes";
import { isValidJobTransition, JobService, sanitizeIdempotencyKey } from "./jobs";
import {
  assertPathInside,
  checkStoragePolicy,
  cleanupTemporaryArtifacts,
} from "./storage/storagePolicy";
import type { JobStatus } from "./types";

type JobRow = {
  id: string;
  type: "video";
  status: JobStatus;
  progress: number;
  current_stage: string;
  title?: string;
  creation_mode?: "prompt" | "template";
  original_prompt?: string;
  production_spec?: any;
  ai_provider?: string;
  visual_mode?: string;
  voice_provider?: string;
  quality_profile?: string;
  resolution?: string;
  aspect_ratio?: string;
  language?: string;
  dialect?: string;
  cost_estimate?: any;
  idempotency_key?: string;
  template_id?: string;
  brand_name?: string;
  input: any;
  output?: any;
  error?: string;
  technical_error?: string;
  created_at: Date;
  started_at?: Date;
  completed_at?: Date;
  updated_at: Date;
};

class FakeDb {
  public jobs = new Map<string, JobRow>();
  public events: any[] = [];
  public assets: any[] = [];
  public brands = new Map<string, any>();
  public templates = new Map<string, any>();
  public templatePreferences = new Map<string, any>();
  public settings = new Map<string, any>();

  async query(text: string, values: any[] = []) {
    if (text.includes("SELECT key, value, updated_at FROM app_settings")) {
      const value = this.settings.get(values[0]);
      return value ? [{ key: values[0], value, updated_at: new Date() }] : [];
    }
    if (text.includes("INSERT INTO app_settings")) {
      this.settings.set(values[0], values[1]);
      return [{ key: values[0], value: values[1], updated_at: new Date() }];
    }
    if (text.includes("SELECT count(*) as count FROM jobs WHERE brand_name")) {
      return [{ count: "0" }];
    }
    if (text.includes("SELECT revisions FROM brands WHERE id")) {
      const row = this.brands.get(values[0]);
      return row ? [{ revisions: row.revisions || [] }] : [];
    }
    if (text.includes("SELECT * FROM brands WHERE id")) {
      const row = this.brands.get(values[0]);
      return row ? [row] : [];
    }
    if (text.includes("SELECT * FROM brands")) {
      const includeArchived = values[0] === true;
      return Array.from(this.brands.values()).filter((row) => includeArchived || !row.archived_at);
    }
    if (text.includes("UPDATE brands SET is_default = false WHERE id <>")) {
      for (const [id, row] of this.brands) {
        if (id !== values[0]) row.is_default = false;
      }
      return [];
    }
    if (text.includes("UPDATE brands SET is_default = false")) {
      for (const row of this.brands.values()) row.is_default = false;
      return [];
    }
    if (text.includes("INSERT INTO brands")) {
      const now = new Date();
      const defaultIndex = values.length === 26 ? 10 : -1;
      const offset = values.length === 26 ? 0 : -1;
      const row = {
        id: values[0],
        name: values[1],
        watermark_text: values[2],
        primary_color: values[3],
        accent_color: values[4],
        caption_style: values[5],
        include_outro: values[6],
        outro_text: values[7],
        contact_text: values[8],
        voice_profile: values[9] ? JSON.parse(values[9]) : null,
        is_default: defaultIndex >= 0 ? values[defaultIndex] : false,
        secondary_color: values[11 + offset] || null,
        logo_url: values[12 + offset] || null,
        website_url: values[13 + offset] || null,
        social_handle: values[14 + offset] || null,
        description: values[15 + offset] || null,
        industry: values[16 + offset] || null,
        tagline: values[17 + offset] || null,
        logo_asset_id: values[18 + offset] || null,
        icon_asset_id: values[19 + offset] || null,
        background_color: values[20 + offset] || null,
        text_color: values[21 + offset] || null,
        heading_font: values[22 + offset] || null,
        body_font: values[23 + offset] || null,
        caption_font: values[24 + offset] || null,
        kit: values[25 + offset] ? JSON.parse(values[25 + offset]) : {},
        revision: 1,
        revisions: [],
        archived_at: null,
        created_at: now,
        updated_at: now,
      };
      this.brands.set(row.id, row);
      return [row];
    }
    if (text.includes("UPDATE brands SET revisions")) {
      const row = this.brands.get(values[0]);
      if (row) row.revisions = JSON.parse(values[1]);
      return [];
    }
    if (text.includes("UPDATE brands") && text.includes("RETURNING *")) {
      const row = this.brands.get(values[0]);
      if (!row) return [];
      if (text.includes("SET is_default = true")) {
        row.is_default = true;
        row.archived_at = null;
      } else if (text.includes("SET archived_at = now()")) {
        row.archived_at = new Date();
        row.is_default = false;
      } else if (text.includes("SET archived_at = NULL")) {
        row.archived_at = null;
      } else {
        row.name = values[1];
        row.watermark_text = values[2];
        row.primary_color = values[3];
        row.accent_color = values[4];
        row.caption_style = values[5];
        row.include_outro = values[6];
        row.outro_text = values[7];
        row.contact_text = values[8];
        row.voice_profile = values[9] ? JSON.parse(values[9]) : null;
        row.is_default = values[10];
        row.secondary_color = values[11] || null;
        row.logo_url = values[12] || null;
        row.website_url = values[13] || null;
        row.social_handle = values[14] || null;
        row.description = values[15] || null;
        row.industry = values[16] || null;
        row.tagline = values[17] || null;
        row.logo_asset_id = values[18] || null;
        row.icon_asset_id = values[19] || null;
        row.background_color = values[20] || null;
        row.text_color = values[21] || null;
        row.heading_font = values[22] || null;
        row.body_font = values[23] || null;
        row.caption_font = values[24] || null;
        row.kit = values[25] ? JSON.parse(values[25]) : {};
        row.revision = values[26] || row.revision;
        row.revisions = values[27] ? JSON.parse(values[27]) : row.revisions;
        row.archived_at = values[28] === true ? row.archived_at : null;
      }
      row.updated_at = new Date();
      return [row];
    }
    if (text.includes("DELETE FROM brands")) {
      const row = this.brands.get(values[0]);
      if (!row) return [];
      this.brands.delete(values[0]);
      return [row];
    }
    if (text.includes("SELECT * FROM video_template_preferences")) {
      return Array.from(this.templatePreferences.values());
    }
    if (text.includes("INSERT INTO video_template_preferences")) {
      const row = { template_id: values[0], favorite: values[1], updated_at: new Date() };
      this.templatePreferences.set(row.template_id, row);
      return [row];
    }
    if (text.includes("SELECT * FROM video_templates WHERE id")) {
      const row = this.templates.get(values[0]);
      return row ? [row] : [];
    }
    if (text.includes("SELECT * FROM video_templates")) {
      const includeArchived = values[0] === true;
      return Array.from(this.templates.values()).filter((row) => includeArchived || !row.archived_at);
    }
    if (text.includes("INSERT INTO video_templates")) {
      const now = new Date();
      const row = {
        id: values[0],
        name: values[1],
        description: values[2],
        category: values[3],
        source: "custom",
        base_template_id: values[4] || null,
        favorite: values[5] === true,
        archived_at: text.includes("archived_at") && values[6] ? new Date(values[6]) : null,
        revision: 1,
        config: JSON.parse(text.includes("archived_at") ? values[7] : values[5]),
        variables: JSON.parse(text.includes("archived_at") ? values[8] : values[6]),
        revisions: JSON.parse(text.includes("archived_at") ? values[9] : values[7]),
        created_at: now,
        updated_at: now,
      };
      this.templates.set(row.id, row);
      return [row];
    }
    if (text.includes("UPDATE video_templates") && text.includes("RETURNING *")) {
      const row = this.templates.get(values[0]);
      if (!row) return [];
      if (text.includes("SET favorite = $2")) {
        row.favorite = values[1] === true;
      } else if (text.includes("SET archived_at = now()")) {
        row.archived_at = new Date();
      } else if (text.includes("SET archived_at = NULL")) {
        row.archived_at = null;
      } else {
        row.name = values[1];
        row.description = values[2];
        row.category = values[3];
        row.base_template_id = values[4] || null;
        row.favorite = values[5] === true;
        row.archived_at = values[6] === true ? row.archived_at || new Date() : null;
        row.revision = values[7];
        row.config = JSON.parse(values[8]);
        row.variables = JSON.parse(values[9]);
        row.revisions = JSON.parse(values[10]);
      }
      row.updated_at = new Date();
      return [row];
    }
    if (text.includes("INSERT INTO jobs")) {
      const [
        id,
        title,
        templateId,
        brandName,
        input,
        creationMode,
        originalPrompt,
        productionSpecJson,
        aiProvider,
        visualMode,
        voiceProvider,
        qualityProfile,
        resolution,
        aspectRatio,
        language,
        dialect,
        costEstimateJson,
        idempotencyKey,
      ] = values;
      if (idempotencyKey) {
        const existing = Array.from(this.jobs.values()).find((job) => job.idempotency_key === idempotencyKey);
        if (existing) return [];
      }
      const now = new Date();
      const row: JobRow = {
        id,
        type: "video",
        status: "queued",
        progress: 0,
        current_stage: "Queued",
        title,
        template_id: templateId,
        brand_name: brandName,
        input,
        creation_mode: creationMode,
        original_prompt: originalPrompt,
        production_spec: productionSpecJson ? JSON.parse(productionSpecJson) : undefined,
        ai_provider: aiProvider,
        visual_mode: visualMode,
        voice_provider: voiceProvider,
        quality_profile: qualityProfile,
        resolution,
        aspect_ratio: aspectRatio,
        language,
        dialect,
        cost_estimate: costEstimateJson ? JSON.parse(costEstimateJson) : undefined,
        idempotency_key: idempotencyKey,
        created_at: now,
        updated_at: now,
      };
      this.jobs.set(id, row);
      return [row];
    }
    if (text.includes("INSERT INTO job_events")) {
      const row = {
        id: String(this.events.length + 1),
        job_id: values[0],
        status: values[1],
        progress: values[2],
        stage: values[3],
        message: values[4],
        technical_message: values[5],
        created_at: new Date(),
      };
      this.events.push(row);
      return [row];
    }
    if (text.includes("SELECT * FROM jobs WHERE idempotency_key")) {
      const row = Array.from(this.jobs.values()).find((job) => job.idempotency_key === values[0]);
      return row ? [row] : [];
    }
    if (text.includes("SELECT * FROM jobs WHERE id")) {
      const row = this.jobs.get(values[0]);
      return row ? [row] : [];
    }
    if (text.includes("SELECT * FROM jobs WHERE status")) {
      return Array.from(this.jobs.values()).filter((job) => job.status === values[0]);
    }
    if (text.includes("SELECT status, count(*)") && text.includes("FROM jobs")) {
      const counts = new Map<string, number>();
      for (const job of this.jobs.values()) {
        counts.set(job.status, (counts.get(job.status) || 0) + 1);
      }
      return Array.from(counts.entries()).map(([status, count]) => ({ status, count }));
    }
    if (text.includes("count(*)::int AS count FROM jobs WHERE created_at")) {
      return [{ count: this.jobs.size }];
    }
    if (text.includes("SELECT * FROM jobs ORDER BY")) {
      return Array.from(this.jobs.values());
    }
    if (text.includes("SELECT * FROM job_events")) {
      return this.events.filter((event) => event.job_id === values[0]);
    }
    if (text.includes("UPDATE jobs")) {
      const row = this.jobs.get(values[0]);
      if (!row) return [];
      row.status = values[1];
      row.progress = values[2];
      row.current_stage = values[3];
      row.output = values[4] || row.output;
      row.error = values[5] || row.error;
      row.technical_error = values[6] || row.technical_error;
      row.started_at = row.started_at || new Date();
      if (["ready", "failed", "canceled"].includes(row.status)) {
        row.completed_at = new Date();
      }
      row.updated_at = new Date();
      return [row];
    }
    if (text.includes("INSERT INTO generated_assets")) {
      this.assets.push(values);
      return [];
    }
    return [];
  }

  async health() {
    return { ok: true, message: "PostgreSQL connection is healthy." };
  }
}

const validInput = {
  scenes: [{ text: "A short test narration", searchTerms: ["retail", "shop"] }],
  config: { brandKit: { brandName: "ABUD Test" } },
};

function makeConfig(): Config {
  process.env.PEXELS_API_KEY = "A".repeat(56);
  process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token-value";
  process.env.V2_ENABLED = "true";
  const config = new Config();
  config.n8nBaseUrl = "http://127.0.0.1:1";
  config.renderWorkerBaseUrl = "http://127.0.0.1:1";
  return config;
}

describe("V2 jobs", () => {
  it("creates, transitions, completes, fails, and cancels jobs with events", async () => {
    const db = new FakeDb();
    const service = new JobService(db as any);
    const job = await service.createVideoJob(validInput as any);

    expect(job.status).toBe("queued");
    expect((await service.getEvents(job.id))).toHaveLength(1);

    await service.updateJob(job.id, "preparing", 5, "Preparing", "Preparing.");
    await service.updateJob(job.id, "generating_voice", 30, "Generating voice", "Voice.");
    await service.updateJob(job.id, "generating_captions", 50, "Captions", "Captions.");
    await service.updateJob(job.id, "searching_assets", 60, "Footage", "Footage.");
    await service.updateJob(job.id, "rendering", 80, "Rendering", "Rendering.");
    await service.updateJob(job.id, "finalizing", 95, "Finalizing", "Finalizing.");
    const complete = await service.completeJob(job.id, job.id, { path: "/app/data/videos/test.mp4" });
    expect(complete.status).toBe("ready");
    expect(complete.output?.videoId).toBe(job.id);

    const failed = await service.createVideoJob(validInput as any);
    await service.updateJob(failed.id, "failed", 100, "Failed", "Failed.", { error: "Render failed" });
    expect((await service.getJob(failed.id))?.error).toBe("Render failed");

    const canceled = await service.createVideoJob(validInput as any);
    expect((await service.cancelJob(canceled.id)).status).toBe("canceled");
  });

  it("rejects invalid transitions", () => {
    expect(isValidJobTransition("queued", "ready")).toBe(false);
    expect(isValidJobTransition("queued", "preparing")).toBe(true);
    expect(isValidJobTransition("ready", "rendering")).toBe(false);
  });

  it("reuses the existing job for a valid idempotency key", async () => {
    const db = new FakeDb();
    const service = new JobService(db as any);
    const first = await service.createVideoJob({
      ...validInput,
      idempotencyKey: "job-retry-001",
    } as any);
    const second = await service.createVideoJob({
      ...validInput,
      title: "Duplicate retry should not create a new job",
      idempotencyKey: "job-retry-001",
    } as any);

    expect(second.id).toBe(first.id);
    expect(Array.from(db.jobs.values())).toHaveLength(1);
    expect(second.idempotencyKey).toBe("job-retry-001");
    expect(sanitizeIdempotencyKey("../../bad")).toBeUndefined();
  });

  it("creates checkpoint-aware idempotent full retries with reusable billable voice artifacts", async () => {
    const db = new FakeDb();
    const service = new JobService(db as any);
    const original = await service.createVideoJob({
      type: "video",
      creationMode: "prompt",
      productionSpec: {
        id: "original",
        title: "إنتاج إعلان مدته 10",
        userPrompt: "اعمل Reel سريع مدته 20 ثانية",
        language: "ar",
        dialect: "egyptian",
        durationSeconds: 10,
        aspectRatio: "16:9",
        resolution: "1080p",
        quality: "standard",
        productionMode: "studio",
        visualMode: "auto",
        voiceProvider: "elevenlabs",
        voiceId: "voice_abc",
        captionStyle: "bold",
        scenes: [
          {
            sceneIndex: 0,
            purpose: "hook",
            durationSeconds: 3,
            narration: "مشهد أول",
            stockSearchTerms: ["fashion"],
            visualSource: "stock",
          },
        ],
      },
    } as any);
    const row = db.jobs.get(original.id)! as any;
    row.status = "failed";
    row.progress = 100;
    row.current_stage = "Generating voice";
    row.completed_at = new Date();
    row.checkpoint = {
      planning: { status: "completed", attempt: 1 },
      media: { status: "completed", attempt: 1 },
      voice: { status: "running", attempt: 2 },
    };

    const voiceArtifact: any = {
      artifactId: "voice_abc1234567890abc_deadbeef0000",
      type: "voice",
      sceneIndex: 0,
      sourceJobId: original.id,
      provider: "elevenlabs",
      inputHash: "abc",
      storageRef: "artifacts/scene/voice/voice_abc1234567890abc_deadbeef0000.mp3",
      checksum: "d".repeat(64),
      createdAt: new Date().toISOString(),
      metadata: { reuseKey: { voiceId: "voice_abc" } },
      valid: true,
    };
    const captionArtifact: any = {
      artifactId: "captions_def1234567890def_feedface0000",
      type: "captions",
      sceneIndex: 0,
      sourceJobId: original.id,
      provider: "elevenlabs",
      inputHash: "def",
      storageRef: "artifacts/scene/captions/captions_def1234567890def_feedface0000.json",
      checksum: "f".repeat(64),
      createdAt: new Date().toISOString(),
      valid: true,
    };
    const mediaArtifact: any = {
      artifactId: "media_ghi1234567890ghi_cafebabe0000",
      type: "media",
      sceneIndex: 0,
      sourceJobId: original.id,
      provider: "pexels",
      inputHash: "ghi",
      storageRef: "artifacts/scene/media/media_ghi1234567890ghi_cafebabe0000.mp4",
      checksum: "c".repeat(64),
      createdAt: new Date().toISOString(),
      valid: true,
    };
    const artifacts = [voiceArtifact, captionArtifact, mediaArtifact];
    const retry = await service.retryJob(original.id, { reuseArtifacts: artifacts });
    const duplicate = await service.retryJob(original.id, { reuseArtifacts: artifacts });
    const retryMeta = (retry.productionSpec as any).metadata.revision;

    expect(duplicate.id).toBe(retry.id);
    expect(retry.input.__retryOf).toBe(original.id);
    expect(retry.input.__retryReuse.reusedArtifactIds).toEqual([
      voiceArtifact.artifactId,
      captionArtifact.artifactId,
      mediaArtifact.artifactId,
    ]);
    expect(retryMeta.retryOf).toBe(original.id);
    expect(retryMeta.retryNumber).toBe(1);
    expect(retryMeta.reuseStages).toContain("planning");
    expect(retryMeta.reuseStages).toContain("voice");
    expect(retryMeta.reuseStages).toContain("captions");
    expect(retryMeta.reuseStages).toContain("media");
    expect(retryMeta.regeneratedStages).toContain("render");
    expect(retryMeta.regeneratedStages).toContain("validation");
    expect(retryMeta.regeneratedStages).not.toContain("planning");
    expect(retryMeta.regeneratedStages).not.toContain("voice");
    expect(retryMeta.regeneratedStages).not.toContain("captions");
    expect(retryMeta.regeneratedStages).not.toContain("media");
    expect(retryMeta.reuseArtifacts).toHaveLength(3);
    expect(retryMeta.reuseArtifacts[0].provider).toBe("elevenlabs");
    expect(retryMeta.reuseArtifacts[1].type).toBe("captions");
    expect(retryMeta.reuseArtifacts[2].provider).toBe("pexels");
    expect(retryMeta.reuseArtifacts[0].metadata.retryReuseManifest).toMatchObject({
      sceneIndex: 0,
      artifactType: "voice",
      artifactId: voiceArtifact.artifactId,
      sourceJobId: original.id,
      inputHash: "abc",
      inputHashVersion: "legacy",
      checksum: "d".repeat(64),
      provider: "elevenlabs",
      voiceId: "voice_abc",
      compatibilityDecision: "planner_bound",
      compatibilityVersion: "retry-reuse-v1",
    });
    expect(retryMeta.reuseArtifacts[0].metadata.retryReuseManifest.canonicalSpokenContentFingerprint).toHaveLength(64);
    expect(retryMeta.reuseArtifacts[0].metadata.retryReuseManifest.displayContentFingerprint).toHaveLength(64);
  });
});

describe("V2 storage policy", () => {
  it("rejects paths outside the configured data root", () => {
    expect(() => assertPathInside("C:/data/root", "C:/data/root/temp/a.mp4")).not.toThrow();
    expect(() => assertPathInside("C:/data/root", "C:/data/other/a.mp4")).toThrow();
  });

  it("checks writable storage and cleans only old temp files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "abud-v2-storage-"));
    const oldFile = path.join(root, "temp", "old.tmp");
    const newFile = path.join(root, "temp", "new.tmp");
    fs.ensureDirSync(path.dirname(oldFile));
    fs.writeFileSync(oldFile, "old");
    fs.writeFileSync(newFile, "new");
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, oldDate, oldDate);
    const config = makeConfig();
    config.dataDirPath = root;
    config.videosDirPath = path.join(root, "videos");
    config.tempDirPath = path.join(root, "temp");
    config.tempMaxAgeMs = 60 * 60 * 1000;
    config.minFreeDiskBytes = 1;

    const check = await checkStoragePolicy(config);
    expect(check.ok).toBe(true);
    const cleanup = await cleanupTemporaryArtifacts(config);
    expect(cleanup.deleted).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    fs.removeSync(root);
  });
});

describe("V2 runtime config validation", () => {
  it("flags missing app database configuration when V2 is enabled", () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousV2Enabled = process.env.V2_ENABLED;
    const previousInternalToken = process.env.INTERNAL_SERVICE_TOKEN;
    process.env.V2_ENABLED = "true";
    process.env.INTERNAL_SERVICE_TOKEN = "valid-internal-token-value-for-tests";
    delete process.env.DATABASE_URL;
    try {
      const config = new Config();
      config.serviceRole = "app";
      const validation = config.validateRuntimeConfig();

      expect(validation.valid).toBe(false);
      expect(validation.issues.some((issue) => issue.code === "missing_database_url")).toBe(true);
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      if (previousV2Enabled === undefined) {
        delete process.env.V2_ENABLED;
      } else {
        process.env.V2_ENABLED = previousV2Enabled;
      }
      if (previousInternalToken === undefined) {
        delete process.env.INTERNAL_SERVICE_TOKEN;
      } else {
        process.env.INTERNAL_SERVICE_TOKEN = previousInternalToken;
      }
    }
  });

  it("allows local single-user mode only on a loopback public binding", () => {
    const previousV2Enabled = process.env.V2_ENABLED;
    process.env.V2_ENABLED = "true";
    try {
      const config = new Config();
      config.serviceRole = "app";
      config.accessMode = "local";
      config.accessModeConfigValid = true;
      config.publicBindHost = "127.0.0.1";
      config.v2PublicUrl = "http://localhost:3145";
      config.internalServiceToken = "valid-internal-token-value-for-tests";
      config.databaseUrl = "postgres://short_studio:secret@127.0.0.1:5432/short_studio";

      const validation = config.validateRuntimeConfig();
      expect(validation.issues.some((issue) => issue.code === "remote_access_requires_secure_server")).toBe(false);
    } finally {
      if (previousV2Enabled === undefined) {
        delete process.env.V2_ENABLED;
      } else {
        process.env.V2_ENABLED = previousV2Enabled;
      }
    }
  });

  it("fails closed when local single-user mode is exposed beyond localhost", () => {
    const previousV2Enabled = process.env.V2_ENABLED;
    process.env.V2_ENABLED = "true";
    try {
      const config = new Config();
      config.serviceRole = "app";
      config.accessMode = "local";
      config.accessModeConfigValid = true;
      config.publicBindHost = "0.0.0.0";
      config.v2PublicUrl = "http://192.168.1.20:3145";
      config.internalServiceToken = "valid-internal-token-value-for-tests";
      config.databaseUrl = "postgres://short_studio:secret@127.0.0.1:5432/short_studio";

      const validation = config.validateRuntimeConfig();
      expect(validation.valid).toBe(false);
      expect(validation.issues).toContainEqual(
        expect.objectContaining({
          code: "remote_access_requires_secure_server",
          message: REMOTE_ACCESS_REQUIRES_SECURE_SERVER_MODE,
        }),
      );
    } finally {
      if (previousV2Enabled === undefined) {
        delete process.env.V2_ENABLED;
      } else {
        process.env.V2_ENABLED = previousV2Enabled;
      }
    }
  });

  it("does not apply the local exposure block to secure server mode", () => {
    const previousV2Enabled = process.env.V2_ENABLED;
    process.env.V2_ENABLED = "true";
    try {
      const config = new Config();
      config.serviceRole = "app";
      config.accessMode = "secure_server";
      config.accessModeConfigValid = true;
      config.publicBindHost = "0.0.0.0";
      config.v2PublicUrl = "https://shorts.example.com";
      config.internalServiceToken = "valid-internal-token-value-for-tests";
      config.databaseUrl = "postgres://short_studio:secret@127.0.0.1:5432/short_studio";

      const validation = config.validateRuntimeConfig();
      expect(validation.issues.some((issue) => issue.code === "remote_access_requires_secure_server")).toBe(false);
    } finally {
      if (previousV2Enabled === undefined) {
        delete process.env.V2_ENABLED;
      } else {
        process.env.V2_ENABLED = previousV2Enabled;
      }
    }
  });
});

describe("Server request boundary", () => {
  it("returns request-correlated API 404 errors", async () => {
    const config = makeConfig();
    config.port = 0;
    const server = new Server(config, {} as ShortCreator);
    const res = await request(server.getApp())
      .get("/api/does-not-exist")
      .set("x-request-id", "request-test-001")
      .expect(404);

    expect(res.headers["x-request-id"]).toBe("request-test-001");
    expect(res.body.error.code).toBe("not_found");
    expect(res.body.error.requestId).toBe("request-test-001");
  });
});

describe("V2 routes", () => {
  const authHeader = { Authorization: "Bearer test_admin_session" };

  afterEach(() => {
    nock.cleanAll();
  });

  it("protects internal endpoints", async () => {
    const app = express();
    app.use("/internal/v1", createV2InternalRouter(makeConfig(), {} as ShortCreator));
    await request(app).post("/internal/v1/render/jobs/test/start").send({}).expect(401);
  });

  it("rejects internal completion when final metadata failed professional readiness", async () => {
    const config = makeConfig();
    const videosDir = fs.mkdtempSync(path.join(os.tmpdir(), "abud-v2-complete-"));
    config.videosDirPath = videosDir;
    writeMetadata(videosDir, {
      videoId: "vid_failed_gate",
      filename: "vid_failed_gate.mp4",
      status: "failed",
      error: "One or more sections need better footage; a scene fell back to a graphic instead of real video.",
      professionalReady: false,
    } as any);
    const jobs = {
      completeJob: vi.fn(),
      updateJob: vi.fn(async (_id: string, status: string, progress: number, stage: string, message: string, options: any) => ({
        id: "job_failed_gate",
        status,
        progress,
        currentStage: stage,
        error: options.error,
        output: options.output,
        message,
      })),
    };

    const app = express();
    app.use("/internal/v1", createV2InternalRouter(config, {} as ShortCreator, jobs as any));

    const res = await request(app)
      .post("/internal/v1/jobs/job_failed_gate/complete")
      .set("x-internal-token", config.internalServiceToken)
      .send({ videoId: "vid_failed_gate", output: { path: "/app/data/videos/vid_failed_gate.mp4" } })
      .expect(200);

    expect(jobs.completeJob).not.toHaveBeenCalled();
    expect(jobs.updateJob).toHaveBeenCalledWith(
      "job_failed_gate",
      "failed",
      99,
      "Quality review failed",
      expect.stringContaining("Final video quality checks"),
      expect.objectContaining({
        error: expect.stringContaining("Final video quality checks"),
        technicalError: expect.stringContaining("better footage"),
        output: expect.objectContaining({
          videoId: "vid_failed_gate",
          professionalReady: false,
          validationStatus: "failed",
        }),
      }),
    );
    expect(res.body.job.status).toBe("failed");
  });

  it("keeps media API responses free of internal storage details", () => {
    const asset = serializeMediaAssetForApi({
      id: "asset_1",
      filename: "asset.png",
      originalName: "asset.png",
      displayName: "Reference image",
      mediaType: "image",
      purpose: "character_reference",
      mimeType: "image/png",
      sizeBytes: 1024,
      width: 1024,
      height: 1024,
      checksum: "private-checksum",
      storagePath: "C:\\private\\uploads\\asset.png",
      relativePath: "uploads/asset.png",
      previewUrl: "/media/uploads/asset.png",
      folderId: "folder_1",
      tags: ["hero"],
      status: "ready",
      usable: true,
      usageCount: 0,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
      uploadedAt: "2026-08-27T00:00:00.000Z",
      nobgArtifactId: "artifact_private",
      nobgRelativePath: "uploads/asset-nobg.png",
      usability: {
        usableForVideo: true,
        usableForProduct: true,
        usableForLogo: true,
        usableForCharacterReference: true,
        reasons: {},
      },
    });

    const product = serializeProductMediaForApi({
      id: "product_1",
      filename: "product.png",
      originalName: "Product",
      mimeType: "image/png",
      sizeBytes: 2048,
      width: 1200,
      height: 1200,
      checksum: "private-product-checksum",
      storagePath: "/app/data/uploads/product.png",
      relativePath: "uploads/product.png",
      uploadedAt: "2026-08-27T00:00:00.000Z",
      nobgArtifactId: "product_artifact_private",
      nobgRelativePath: "uploads/product-nobg.png",
      usable: true,
    });

    const body = JSON.stringify({ asset, product });
    expect(asset.previewUrl).toBe("/media/uploads/asset.png");
    expect(body).not.toContain("storagePath");
    expect(body).not.toContain("relativePath");
    expect(body).not.toContain("checksum");
    expect(body).not.toContain("nobgArtifactId");
    expect(body).not.toContain("nobgRelativePath");
    expect(body).not.toContain("C:\\");
    expect(body).not.toContain("/app/data");
  });

  it("validates public job payloads and redacts settings secrets", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    await request(app).post("/api/v2/jobs").set(authHeader).send({ scenes: [] }).expect(400);
    const settings = await request(app).get("/api/v2/settings").set(authHeader).expect(200);
    expect(settings.body.pexels.redactedKey).toBe("••••••••");
    expect(JSON.stringify(settings.body)).not.toContain("A".repeat(56));
  });

  it("generates production spec preview and prompt enhancement via API", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const preview = await request(app)
      .post("/api/v2/production-spec/preview")
      .set(authHeader)
      .send({ prompt: "اعمل اعلان 20 ثانية لبراند ملابس" })
      .expect(200);

    expect(preview.body.spec.creationMode).toBe("prompt");
    expect(preview.body.spec.scenes.length).toBeGreaterThanOrEqual(3);
    expect(preview.body.costEstimate.isFree).toBe(true);

    const enhance = await request(app)
      .post("/api/v2/prompt/enhance")
      .set(authHeader)
      .send({ prompt: "اعمل اعلان لكافيه" })
      .expect(200);

    expect(enhance.body.enhancedPrompt.length).toBeGreaterThan(15);
    expect(enhance.body.changesSummary.length).toBeGreaterThan(0);
  });

  it("creates a Prompt Mode job and persists ProductionSpec", async () => {
    nock("http://127.0.0.1:1")
      .post("/webhook/abud-v2/jobs/start")
      .reply(202, { accepted: true });

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        creationMode: "prompt",
        prompt: "Create a 30-second English tech tutorial about automated cloud backups",
        language: "en",
        durationSeconds: 30,
      })
      .expect(201);

    expect(res.body.job.id).toBeDefined();
    expect(res.body.job.creationMode).toBe("prompt");
    expect(res.body.job.language).toBe("en");
    expect(res.body.job.productionSpec).toBeDefined();
  });

  it("accepts prompt-only creation and resolves safe automatic defaults", async () => {
    nock("http://127.0.0.1:1")
      .post("/webhook/abud-v2/jobs/start")
      .reply(202, { accepted: true });

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        prompt: "Create a 10-second vertical Reel about three quick ways to make a small business website look more professional.",
      })
      .expect(201);

    expect(res.body.job.creationMode).toBe("prompt");
    expect(res.body.job.productionSpec.durationSeconds).toBeGreaterThanOrEqual(5);
    expect(res.body.job.productionSpec.visualMode).toBe("auto");
    expect(res.body.job.productionSpec.voiceProvider).toBe("kokoro");
    expect(res.body.job.productionSpec.metadata.uiContract.visualSource).toBe("auto_best");
  });

  it("preserves direct ProductionSpec visual contract metadata on job creation", async () => {
    nock("http://127.0.0.1:1")
      .post("/webhook/abud-v2/jobs/start")
      .reply(202, { accepted: true });

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        type: "video",
        title: "Direct free-stock contract",
        creationMode: "prompt",
        prompt: "Create a short coffee shop video with free stock visuals.",
        productionSpec: {
          id: "direct_free_stock_contract",
          title: "Direct free-stock contract",
          language: "en",
          durationSeconds: 20,
          visualMode: "auto",
          metadata: {
            visualSource: "auto_free",
            budgetMode: "free_only",
            stockProvider: "auto_stock",
            uiContract: {
              visualSource: "auto_free",
              budgetMode: "free_only",
              stockProvider: "auto_stock",
              paidCallsAllowed: false,
            },
          },
          scenes: [
            {
              sceneIndex: 0,
              purpose: "hook",
              durationSeconds: 5,
              narration: "Start the morning with a simple cup of coffee.",
              displayText: "Morning coffee",
              visualSource: "stock",
              stockSearchTerms: ["coffee shop morning"],
            },
          ],
        },
      })
      .expect(201);

    expect(res.body.job.productionSpec.metadata.uiContract.visualSource).toBe("auto_free");
    expect(res.body.job.productionSpec.metadata.uiContract.sourceStrategy).toBe("Auto Free");
    expect(res.body.job.productionSpec.metadata.uiContract.budgetMode).toBe("free_only");
    expect(res.body.job.productionSpec.metadata.uiContract.paidCallsAllowed).toBe(false);
  });

  it("accepts production job Free Only visual routing controls", async () => {
    nock("http://127.0.0.1:1")
      .post("/webhook/abud-v2/jobs/start")
      .reply(202, { accepted: true });

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/production/jobs")
      .set(authHeader)
      .send({
        prompt: "Create a 20-second vertical Reel with real stock footage.",
        language: "en",
        durationSeconds: 20,
        visualMode: "auto",
        visualSource: "auto_free",
        stockProvider: "auto_stock",
        qualityProfile: "balanced",
      })
      .expect(202);

    const job = await db.jobs.get(res.body.jobId);
    expect(job?.production_spec?.metadata?.uiContract?.visualSource).toBe("auto_free");
    expect(job?.production_spec?.metadata?.uiContract?.sourceStrategy).toBe("Auto Free");
    expect(job?.production_spec?.metadata?.uiContract?.stockProvider).toBe("auto_stock");
  });

  it("V2.4 Pass 5.1: refuses an unknown factual topic with a customer-safe block instead of low-content filler", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/production/jobs")
      .set(authHeader)
      .send({
        prompt: "Why does bread become stale?",
        language: "en",
        durationSeconds: 20,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("content_confidence_low");
    expect(res.body.message).toBe(
      "Better content generation is needed for this topic. Connect a Content AI provider or adjust the prompt.",
    );
    // Customer-safe: no internal provider/model terminology leaked to Simple mode.
    const surface = JSON.stringify(res.body).toLowerCase();
    expect(surface).not.toContain("ollama");
    expect(surface).not.toContain("gemini");
    expect(surface).not.toContain("local_ai");
  });

  it("V2.4 Pass 5.1: still creates the job normally for a business brief in Basic mode", async () => {
    nock("http://127.0.0.1:1")
      .post("/webhook/abud-v2/jobs/start")
      .reply(202, { accepted: true });

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/production/jobs")
      .set(authHeader)
      .send({
        prompt: "Create a 20-second vertical ad for our web design service.",
        language: "en",
        durationSeconds: 20,
      });

    expect(res.status).toBe(202);
    const job = await db.jobs.get(res.body.jobId);
    // The fact-pack/DETERMINISTIC pipeline was removed in the production-
    // intelligence recovery; the labelled Basic planner emits
    // BASIC_FALLBACK provenance and never invents a contact channel.
    expect(job?.production_spec?.metadata?.contentProvenance).toBe("BASIC_FALLBACK");
    expect(job?.production_spec?.cta?.contact).toBeUndefined();
  });

  it("supports captions off without requiring caption artifacts", async () => {
    nock("http://127.0.0.1:1")
      .post("/webhook/abud-v2/jobs/start")
      .reply(202, { accepted: true });

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        prompt: "Create a 10-second English Reel about a cleaner homepage.",
        language: "en",
        captionEnabled: false,
      })
      .expect(201);

    expect(res.body.job.productionSpec.captionStyle).toBe("none");
    expect(res.body.job.productionSpec.metadata.uiContract.captionEnabled).toBe(false);
  });

  it("blocks stock-only creation when no selected stock provider is configured", async () => {
    const previousPexels = process.env.PEXELS_API_KEY;
    delete process.env.PEXELS_API_KEY;
    const config = makeConfig();
    config.pexelsApiKey = "";
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        prompt: "Create an English stock-only Reel about a restaurant offer.",
        language: "en",
        visualSource: "stock",
        stockProvider: "pexels",
      })
      .expect(409);

    expect(res.body.error).toBe("production_not_runnable");
    expect(res.body.message).toMatch(/Stock provider required/i);

    if (previousPexels === undefined) delete process.env.PEXELS_API_KEY;
    else process.env.PEXELS_API_KEY = previousPexels;
  });

  it("blocks uploaded-media-only creation until usable media is selected", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        prompt: "Create an English Reel using only my uploaded product media.",
        language: "en",
        visualSource: "uploaded_media",
        mediaPolicy: "only_selected",
      })
      .expect(409);

    expect(res.body.error).toBe("production_not_runnable");
    expect(res.body.message).toMatch(/Select usable media/i);
  });

  it("locks AI Generated visuals when no AI video provider is configured", async () => {
    const previousVeo = process.env.VEO_API_KEY;
    const previousGoogle = process.env.GOOGLE_AI_API_KEY;
    const previousFal = process.env.FAL_KEY;
    delete process.env.VEO_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.FAL_KEY;

    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .post("/api/v2/jobs")
      .set(authHeader)
      .send({
        prompt: "Create an English Reel with AI generated visuals.",
        language: "en",
        visualSource: "ai_generated",
      })
      .expect(409);

    expect(res.body.message).toMatch(/AI video provider/i);

    if (previousVeo === undefined) delete process.env.VEO_API_KEY;
    else process.env.VEO_API_KEY = previousVeo;
    if (previousGoogle === undefined) delete process.env.GOOGLE_AI_API_KEY;
    else process.env.GOOGLE_AI_API_KEY = previousGoogle;
    if (previousFal === undefined) delete process.env.FAL_KEY;
    else process.env.FAL_KEY = previousFal;
  });

  it("blocks Stock Only when a Character Profile is selected", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .get("/api/v2/system/readiness")
      .set(authHeader)
      .query({
        productionMode: "auto_hybrid",
        visualSource: "stock",
        stockProvider: "pexels",
        characterProfileId: "char_missing",
        language: "en",
      })
      .expect(200);

    expect(res.body.ready).toBe(false);
    expect(res.body.characterConsistencyAvailable).toBe(false);
    expect(res.body.missingRequirements.join(" ")).toMatch(/Stock footage cannot guarantee/i);
  });

  it("reports reference capability only through the hidden compatible test provider", async () => {
    const previous = process.env.ABUD_TEST_REFERENCE_VISUAL_PROVIDER;
    process.env.ABUD_TEST_REFERENCE_VISUAL_PROVIDER = "true";
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app)
      .get("/api/v2/system/readiness")
      .set(authHeader)
      .query({
        productionMode: "auto_hybrid",
        visualSource: "mixed",
        characterProfileId: "char_missing",
        language: "en",
      })
      .expect(200);

    expect(res.body.characterConsistencyAvailable).toBe(true);
    expect(res.body.capabilities.find((cap: any) => cap.id === "character_reference_provider")?.ready).toBe(true);
    expect(res.body.missingRequirements.join(" ")).toMatch(/active Character Profile/i);

    if (previous === undefined) delete process.env.ABUD_TEST_REFERENCE_VISUAL_PROVIDER;
    else process.env.ABUD_TEST_REFERENCE_VISUAL_PROVIDER = previous;
  });

  it("keeps a generic Auto Reel out of geometric motion graphics by default", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const preview = await request(app)
      .post("/api/v2/production-spec/preview")
      .set(authHeader)
      .send({
        prompt: "Create a 10-second vertical Reel about three quick ways to make a small business website look more professional.",
        language: "en",
      })
      .expect(200);

    expect(preview.body.spec.productionMode).not.toBe("motion_graphics");
    expect(preview.body.spec.productionMode).not.toBe("animated_explainer");
    expect(preview.body.spec.scenes.map((scene: any) => scene.visualSource)).not.toContain("motion_graphics");
  });

  it("lists categorized providers and tests connection endpoints", async () => {
    nock("http://127.0.0.1:1").get("/healthz").reply(200, { ok: true });
    nock("http://127.0.0.1:1").get("/health").reply(200, { ok: true });
    nock("https://api.pexels.com").get("/v1/videos/search").query(true).reply(200, { videos: [] });
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const res = await request(app).get("/api/v2/providers").set(authHeader).expect(200);
    expect(res.body.providers.some((p: any) => p.category === "Content AI")).toBe(true);
    expect(res.body.providers.some((p: any) => p.category === "Visuals")).toBe(true);
    expect(res.body.providers.some((p: any) => p.category === "Voice")).toBe(true);
    const pexels = res.body.providers.find((p: any) => p.id === "pexels");
    const veo = res.body.providers.find((p: any) => p.id === "veo");
    const fal = res.body.providers.find((p: any) => p.id === "fal");
    expect(pexels.details.visualCapabilities.referenceImage).toBe(false);
    expect(veo.details.visualCapabilities.referenceImage).toBe(false);
    expect(fal.details.visualCapabilities.nativeCharacterIdentity).toBe(false);

    const valGemini = await request(app).post("/api/v2/providers/gemini/validate").set(authHeader).expect(200);
    expect(valGemini.body.provider).toBe("Google Gemini");

    const valKokoro = await request(app).post("/api/v2/providers/kokoro/validate").set(authHeader).expect(200);
    expect(valKokoro.body.healthy).toBe(true);
  });

  it("aggregates health without exposing provider secrets", async () => {
    nock("https://api.pexels.com")
      .get("/v1/videos/search")
      .query(true)
      .reply(200, { videos: [] });
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const response = await request(app).get("/api/v2/system/health").expect(200);
    expect(response.body.components.some((item: any) => item.name === "Database")).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("A".repeat(56));
  });

  it("validates healthy Pexels provider state without returning the secret", async () => {
    nock("https://api.pexels.com")
      .get("/v1/videos/search")
      .query(true)
      .reply(200, { videos: [] });
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const response = await request(app).post("/api/v2/providers/pexels/validate").set(authHeader).expect(200);
    expect(response.body.status).toBe("healthy");
    expect(response.body.configured).toBe(true);
    expect(response.body.componentStatus).toBe("healthy");
    expect(JSON.stringify(response.body)).not.toContain("A".repeat(56));
  });

  it("validates invalid Pexels credentials without returning the secret", async () => {
    nock("https://api.pexels.com")
      .get("/v1/videos/search")
      .query(true)
      .reply(401, { error: "invalid" });
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const response = await request(app).post("/api/v2/providers/pexels/validate").set(authHeader).expect(200);
    expect(response.body.status).toBe("invalid_credentials");
    expect(response.body.configured).toBe(true);
    expect(response.body.componentStatus).toBe("unhealthy");
    expect(JSON.stringify(response.body)).not.toContain("A".repeat(56));
  });

  it("classifies missing, rate-limited, unavailable, and timed-out Pexels checks", async () => {
    const missing = makeConfig();
    missing.pexelsApiKey = "";
    const missingResult = await validatePexelsProvider(missing, { bypassCache: true });
    expect(missingResult.status).toBe("not_configured");
    expect(missingResult.configured).toBe(false);

    const malformed = makeConfig();
    malformed.pexelsApiKey = "invalid-v2-hotfix-key";
    const malformedResult = await validatePexelsProvider(malformed, { bypassCache: true });
    expect(malformedResult.status).toBe("invalid_credentials");
    expect(malformedResult.componentStatus).toBe("unhealthy");

    nock("https://api.pexels.com")
      .get("/v1/videos/search")
      .query(true)
      .reply(429, { error: "rate limited" });
    const limited = makeConfig();
    limited.pexelsApiKey = "B".repeat(56);
    const limitedResult = await validatePexelsProvider(limited, { bypassCache: true });
    expect(limitedResult.status).toBe("rate_limited");
    expect(limitedResult.componentStatus).toBe("degraded");

    nock("https://api.pexels.com")
      .get("/v1/videos/search")
      .query(true)
      .reply(503, { error: "down" });
    const unavailable = makeConfig();
    unavailable.pexelsApiKey = "C".repeat(56);
    const unavailableResult = await validatePexelsProvider(unavailable, { bypassCache: true });
    expect(unavailableResult.status).toBe("provider_unavailable");
    expect(unavailableResult.componentStatus).toBe("degraded");

    nock("https://api.pexels.com")
      .get("/v1/videos/search")
      .query(true)
      .replyWithError(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }));
    const timeout = makeConfig();
    timeout.pexelsApiKey = "D".repeat(56);
    const timeoutResult = await validatePexelsProvider(timeout, { bypassCache: true, timeoutMs: 5 });
    expect(timeoutResult.status).toBe("timeout");
    expect(timeoutResult.componentStatus).toBe("degraded");
  });

  it("supports brand CRUD and app settings persistence", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const created = await request(app)
      .post("/api/v2/brands")
      .set(authHeader)
      .send({
        name: "ABUD",
        watermarkText: "ABUD",
        primaryColor: "#24545a",
        accentColor: "#d28b4c",
        captionStyle: "bold",
        includeOutro: true,
        isDefault: true,
      })
      .expect(201);
    expect(created.body.brand.name).toBe("ABUD");
    expect(created.body.brand.isDefault).toBe(true);

    const listed = await request(app).get("/api/v2/brands").set(authHeader).expect(200);
    expect(listed.body.brands).toHaveLength(1);

    await request(app)
      .put("/api/v2/settings")
      .set(authHeader)
      .send({ defaultBrandId: created.body.brand.id, defaultTemplateId: "product_ad" })
      .expect(200);
    const settings = await request(app).get("/api/v2/settings").set(authHeader).expect(200);
    expect(settings.body.settings.defaultTemplateId).toBe("product_ad");

    await request(app).delete(`/api/v2/brands/${created.body.brand.id}`).set(authHeader).expect(200);
    const empty = await request(app).get("/api/v2/brands").set(authHeader).expect(200);
    expect(empty.body.brands).toHaveLength(0);
    const archived = await request(app).get("/api/v2/brands?includeArchived=true").set(authHeader).expect(200);
    expect(archived.body.brands[0].archived).toBe(true);
  });

  it("serves backend template definitions through V2", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const response = await request(app).get("/api/v2/templates").set(authHeader).expect(200);
    expect(response.body.templates.some((template: any) => template.id === "product_ad")).toBe(true);
  });

  it("creates, resolves, favorites, archives, and restores reusable video templates", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const app = express();
    app.use(express.json());
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const favorite = await request(app)
      .post("/api/v2/templates/product_ad/favorite")
      .set(authHeader)
      .send({ favorite: true })
      .expect(200);
    expect(favorite.body.template.favorite).toBe(true);

    const created = await request(app)
      .post("/api/v2/templates")
      .set(authHeader)
      .send({
        name: "Launch Offer",
        description: "Reusable launch offer template",
        category: "promotional",
        favorite: true,
        config: {
          durationSeconds: 15,
          visualSource: "stock",
          captionStyle: "social_ad",
          promptGuidance: "Launch {{productName}} with {{offer}}.",
        },
        variables: [
          { key: "productName", label: "Product", type: "text", required: true },
          { key: "offer", label: "Offer", type: "text", required: true },
        ],
      })
      .expect(201);
    expect(created.body.template.custom).toBe(true);
    expect(created.body.template.revision).toBe(1);

    const resolved = await request(app)
      .post(`/api/v2/templates/${created.body.template.id}/resolve`)
      .set(authHeader)
      .send({ variables: { productName: "ABUD Studio", offer: "20% off" } })
      .expect(200);
    expect(resolved.body.resolvedConfig.promptGuidance).toContain("ABUD Studio");
    expect(resolved.body.snapshot.resolvedVariables.offer).toBe("20% off");

    await request(app)
      .delete(`/api/v2/templates/${created.body.template.id}`)
      .set(authHeader)
      .expect(200);
    const active = await request(app).get("/api/v2/templates").set(authHeader).expect(200);
    expect(active.body.templates.some((template: any) => template.id === created.body.template.id)).toBe(false);

    await request(app)
      .post(`/api/v2/templates/${created.body.template.id}/restore`)
      .set(authHeader)
      .expect(200);
    const listed = await request(app).get("/api/v2/templates").set(authHeader).expect(200);
    expect(listed.body.templates.some((template: any) => template.id === created.body.template.id)).toBe(true);
  });

  it("serves Productions as a paginated, filtered, customer-safe list", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    const now = Date.now();
    for (let index = 0; index < 8; index += 1) {
      db.jobs.set(`job_${index}`, {
        id: `job_${index}`,
        type: "video",
        status: index % 2 === 0 ? "failed" : "ready",
        progress: 100,
        current_stage: "Ready",
        title: `Production ${index}`,
        original_prompt: index === 3 ? "unique kingfisher prompt" : "generic prompt",
        language: index % 2 === 0 ? "en" : "ar",
        aspect_ratio: "9:16",
        creation_mode: "prompt",
        brand_name: index < 2 ? "ACME" : null,
        production_spec: {
          userPrompt: "generic",
          metadata: { brandSnapshot: { brandName: "ACME", revision: 2 } },
        },
        input: { prompt: "x", idempotencyKey: `key_${index}`, secretThing: "do-not-leak" },
        error: index % 2 === 0 ? "Stock provider is not configured." : null,
        output: index % 2 === 1 ? { videoId: `job_${index}` } : null,
        checkpoint: {},
        stage_timings: {},
        created_at: new Date(now - index * 60000),
        updated_at: new Date(now - index * 60000),
      });
    }
    const app = express();
    app.use(express.json());
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const page1 = await request(app).get("/api/v2/jobs?limit=3").set(authHeader).expect(200);
    expect(page1.body.jobs).toHaveLength(3);
    expect(page1.body.page.hasMore).toBe(true);
    expect(page1.body.counts.total).toBe(8);
    expect(page1.body.counts.needsAttention).toBe(4);
    // customer-safe: no raw request input, no leaked secret
    expect(JSON.stringify(page1.body)).not.toContain("do-not-leak");
    expect(page1.body.jobs[0].input).toBeUndefined();
    expect(page1.body.jobs[0].customerStatus).toBeTruthy();

    const page2 = await request(app)
      .get(`/api/v2/jobs?limit=3&cursor=${encodeURIComponent(page1.body.page.nextCursor)}`)
      .set(authHeader)
      .expect(200);
    expect(page2.body.jobs[0].id).not.toBe(page1.body.jobs[0].id);

    const failedOnly = await request(app).get("/api/v2/jobs?group=needs_attention").set(authHeader).expect(200);
    expect(failedOnly.body.jobs.every((job: any) => job.customerStatus === "needs_attention")).toBe(true);
    expect(failedOnly.body.jobs[0].failure).toBeTruthy();

    const searched = await request(app).get("/api/v2/jobs?search=kingfisher").set(authHeader).expect(200);
    expect(searched.body.jobs).toHaveLength(1);

    const detail = await request(app).get("/api/v2/jobs/job_1").set(authHeader).expect(200);
    expect(detail.body.timeline).toBeTruthy();
    expect(detail.body.job.input).toBeUndefined();
    expect(detail.body.job.snapshots.brand.revision).toBe(2);
  });

  it("scrubs file:// and absolute artifact paths out of a Production Details response", async () => {
    const config = makeConfig();
    const db = new FakeDb();
    db.jobs.set("job_leak", {
      id: "job_leak",
      type: "video",
      status: "ready",
      progress: 100,
      current_stage: "Ready",
      title: "Leak check",
      original_prompt: "x",
      language: "en",
      aspect_ratio: "9:16",
      creation_mode: "prompt",
      production_spec: {
        userPrompt: "x",
        scenes: [{ mediaSegments: [{ url: "file:///app/data/artifacts/motion/motion_a.png" }] }],
      },
      input: { prompt: "x" },
      output: { videoId: "job_leak", path: "/app/data/videos/job_leak.mp4", previewUrl: "/api/short-video/job_leak" },
      checkpoint: { render: { status: "completed", artifacts: { file: "file:///app/data/artifacts/render/out.mp4" } } },
      stage_timings: {},
      created_at: new Date(),
      updated_at: new Date(),
    });
    const app = express();
    app.use(express.json());
    app.use("/api/v2", createV2PublicRouter(config, db as any, new JobService(db as any)));

    const detail = await request(app).get("/api/v2/jobs/job_leak").set(authHeader).expect(200);
    const serialized = JSON.stringify(detail.body);
    expect(serialized).not.toContain("file://");
    expect(serialized).not.toContain("/app/data");
    // useful fields survive
    expect(detail.body.job.output.videoId).toBe("job_leak");
    expect(detail.body.job.output.previewUrl).toBe("/api/short-video/job_leak");
    expect(detail.body.job.output.path).toBeUndefined();
  });
});

describe("legacy video compatibility", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const dir of tempRoots) fs.removeSync(dir);
  });

  it("keeps videos visible without V2 database records", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abud-videos-"));
    tempRoots.push(dir);
    fs.writeFileSync(path.join(dir, "legacy-video.mp4"), "fake");
    const files = listVideoFiles(fs.readdirSync(dir));
    const stats = fs.statSync(path.join(dir, files[0]));
    const merged = mergeMetadata({
      videoId: "legacy-video",
      filename: "legacy-video.mp4",
      status: "ready",
      sizeBytes: stats.size,
      createdAt: stats.mtime.toISOString(),
      downloadUrl: "/api/videos/legacy-video/download",
      previewUrl: "/api/short-video/legacy-video",
    }, readMetadata(dir, "legacy-video"));

    expect(merged.videoId).toBe("legacy-video");
    expect(merged.status).toBe("ready");
  });

  it("preserves metadata sidecars for new generated assets", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "abud-videos-"));
    tempRoots.push(dir);
    writeMetadata(dir, {
      videoId: "new-video",
      filename: "new-video.mp4",
      status: "ready",
      brandName: "ABUD",
    });
    expect(readMetadata(dir, "new-video")?.brandName).toBe("ABUD");
  });
});
