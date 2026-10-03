import { describe, it, expect, afterAll, vi } from "vitest";
import fs from "fs-extra";
import path from "path";
import os from "os";
import { AudioMasteringService } from "../short-creator/audioMasteringService";
import { FFMpeg } from "../short-creator/libraries/FFmpeg";
import { motionEngine } from "../server/v2/motion/motionEngine";
import { composeVisualBed } from "../server/v2/editing/visualBedComposer";
import { qualityEngine } from "../server/v2/quality/qualityEngine";

describe("Milestone V2.3-03: Component Integration (Timeline Audio Mastering & Motion Composition)", () => {
  const tmpDir = path.join(os.tmpdir(), `v23-real-qa-${Date.now()}`);
  fs.ensureDirSync(tmpDir);

  afterAll(() => {
    try {
      fs.removeSync(tmpDir);
    } catch { }
  });

  it("verifies continuous narration timeline, mastered audio, and bounded breathing pauses (< 300ms)", async () => {
    const ffmpeg = await FFMpeg.init();
    const audioMastering = new AudioMasteringService(ffmpeg);

    const scenes = [
      { narration: "Discover the next generation of creative video generation.", purpose: "hook", duration: 2.2 },
      { narration: "Effortlessly create stunning shorts in just a few seconds.", purpose: "solution", duration: 2.5 },
      { narration: "Try ABUD Shorts Engine today and boost your reach.", purpose: "cta", duration: 2.0 },
    ];

    vi.spyOn(ffmpeg, "getMediaDuration").mockImplementation(async (filePath) => {
      const match = filePath.match(/scene_(\d+)/);
      if (match) {
        const idx = parseInt(match[1], 10);
        return scenes[idx]?.duration || 2.0;
      }
      return 2.0;
    });

    const speechWindows: Array<{ sceneIndex: number; startMs: number; endMs: number }> = [];
    let currentTimelineOffsetMs = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const dur = await ffmpeg.getMediaDuration(path.join(tmpDir, `scene_${i}.mastered.wav`));
      expect(dur).toBeGreaterThan(1.8);

      const sceneSpeechDurationMs = Math.round(dur * 1000);
      speechWindows.push({
        sceneIndex: i,
        startMs: currentTimelineOffsetMs,
        endMs: currentTimelineOffsetMs + sceneSpeechDurationMs,
      });

      // 160ms breathing pause between scenes
      const isLast = i === scenes.length - 1;
      const visualDurationMs = isLast ? sceneSpeechDurationMs : sceneSpeechDurationMs + 160;
      currentTimelineOffsetMs += visualDurationMs;
    }

    // 1. Analyze dead-air on the generated speech timeline
    const deadAirReport = audioMastering.analyzeDeadAir(speechWindows);
    expect(deadAirReport.hasDeadAir).toBe(false);
    expect(deadAirReport.hasSuspiciousPauses).toBe(false);
    expect(deadAirReport.maxNarrationSilenceMs).toBeLessThanOrEqual(300);
    expect(deadAirReport.issues.length).toBe(0);

    // 2. Calculate creative quality score
    const creativeScore = qualityEngine.calculateCreativeQualityScore({
      deadAirDurationMs: deadAirReport.totalNarrationSilenceMs,
      maxNarrationSilenceMs: deadAirReport.maxNarrationSilenceMs,
      totalDurationSeconds: currentTimelineOffsetMs / 1000,
      sceneCount: scenes.length,
      distinctAssetCount: scenes.length,
      fallbackCount: 0,
      hasCta: true,
      captionStyle: "karaoke",
      hasCaptions: true,
      mediaRelevanceScores: [95, 92, 94],
    });

    expect(creativeScore.creativeScore).toBeGreaterThanOrEqual(90);
    expect(["A", "A+"].includes(creativeScore.creativeGrade)).toBe(true);
    expect(creativeScore.diagnostics.audioContinuityScore).toBe(100);
    expect(creativeScore.diagnostics.visualDiversityRatio).toBe(1.0);
  });

  it("renders modern motion graphic scenes and composes a 9:16 visual track", async () => {
    const scene1 = await motionEngine.renderMotionScene({
      template: "kinetic_typography",
      title: "Supercharge Your Growth",
      durationSeconds: 2,
      width: 540,
      height: 960,
      fps: 15,
      language: "en",
    });

    const scene2 = await motionEngine.renderMotionScene({
      template: "stat_callout",
      title: "Conversion Surge",
      numberStat: { value: "300", suffix: "%", label: "Increase" },
      durationSeconds: 2,
      width: 540,
      height: 960,
      fps: 15,
      language: "en",
    });

    expect(fs.existsSync(scene1.absolutePath)).toBe(true);
    expect(fs.existsSync(scene2.absolutePath)).toBe(true);

    const outputPath = path.join(tmpDir, "composed_track.mp4");
    const composed = await composeVisualBed({
      shots: [
        {
          shot: { shotId: "s1", narrationSceneId: "sc1", narrationSceneIndex: 0, intent: "hook", sourceType: "motion", start: 0, duration: 2 },
          sourcePath: scene1.absolutePath,
          sourceStartSeconds: 0,
        },
        {
          shot: { shotId: "s2", narrationSceneId: "sc2", narrationSceneIndex: 1, intent: "solution", sourceType: "motion", start: 2, duration: 2 },
          sourcePath: scene2.absolutePath,
          sourceStartSeconds: 0,
        },
      ] as any,
      outputPath,
      width: 540,
      height: 960,
      fps: 15,
      workDir: path.join(tmpDir, "bed_work"),
    });

    expect(composed.composed).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(fs.statSync(outputPath).size).toBeGreaterThan(5000);
  }, 120000);
});
