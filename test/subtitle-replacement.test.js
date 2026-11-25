import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { replaceBurnedInSubtitles } from "../subtitle-tools.js";

test("replaces a timed burned-in subtitle region and exports an MP4", async t => {
  assert.ok(ffmpegPath, "ffmpeg-static binary must be available");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-subtitle-test-"));
  const input = path.join(dir, "input.mp4");
  let rendered = null;
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (rendered?.outputDir) fs.rmSync(rendered.outputDir, { recursive: true, force: true });
  });
  execFileSync(ffmpegPath, [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=navy:s=320x240:r=24:d=2",
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", input
  ]);
  rendered = await replaceBurnedInSubtitles(input, [
    { start: 0.2, end: 1.4, text: "JUSTEVIVO test" }
  ], { x: 0.1, y: 0.7, width: 0.8, height: 0.15 }, {
    color: "#ffffff", boxColor: "#000000", boxOpacity: 0.5
  });
  assert.ok(fs.existsSync(rendered.outputPath));
  assert.ok(rendered.size > 1000);
  assert.equal(rendered.cues, 1);
  assert.equal(rendered.width, 320);
  assert.equal(rendered.height, 240);
});
