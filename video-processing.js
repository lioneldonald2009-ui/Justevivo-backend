import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import ffmpegPath from "ffmpeg-static";

function run(binary, args, timeoutMs = 15 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) { settled = true; reject(new Error("Le traitement vidéo a dépassé le délai autorisé.")); }
    }, timeoutMs);
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    child.on("error", error => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stderr);
      else reject(new Error("Échec du traitement vidéo (FFmpeg). " + stderr.slice(-1200)));
    });
  });
}

function parseSilence(log, duration) {
  const events = [];
  const re = /silence_(start|end):\s*([0-9.]+)/g;
  let match;
  while ((match = re.exec(log))) events.push({ type: match[1], time: Number(match[2]) });
  const intervals = [];
  let start = null;
  for (const event of events) {
    if (event.type === "start") start = event.time;
    else if (start !== null && event.time > start) {
      intervals.push({ start, end: event.time });
      start = null;
    }
  }
  return intervals;
}

export async function removeSilenceFromVideo(inputPath, options = {}) {
  if (!ffmpegPath) throw new Error("Le moteur FFmpeg n'est pas disponible sur ce serveur.");
  const threshold = Math.max(-60, Math.min(-20, Number(options.thresholdDb) || -38));
  const minSilence = Math.max(0.35, Math.min(3, Number(options.minSilenceSeconds) || 0.7));
  const padding = Math.max(0.05, Math.min(0.35, Number(options.paddingSeconds) || 0.12));

  const probe = await run(ffmpegPath, ["-hide_banner", "-i", inputPath], 30000).catch(e => {
    // ffmpeg retourne habituellement un code non nul pour -i sans sortie, mais le log contient les streams.
    const text = String(e.message || "");
    if (/Duration:/.test(text)) return text;
    throw e;
  });
  const durationMatch = probe.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!durationMatch) throw new Error("Impossible de lire la durée de cette vidéo.");
  const duration = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 3600) throw new Error("La vidéo doit durer moins de 60 minutes.");
  const hasAudio = /Stream #\d+:\d+.*Audio:/.test(probe);
  if (!hasAudio) throw new Error("Cette vidéo ne contient pas de piste audio à analyser.");

  const silenceLog = await run(ffmpegPath, [
    "-hide_banner", "-i", inputPath, "-vn", "-af",
    "silencedetect=noise=" + threshold + "dB:d=" + minSilence,
    "-f", "null", "-"
  ]);
  const detected = parseSilence(silenceLog, duration);
  const cuts = detected
    .map(s => ({ start: Math.max(0, s.start + padding), end: Math.min(duration, s.end - padding) }))
    .filter(s => s.end - s.start >= 0.12);
  const keep = [];
  let cursor = 0;
  for (const cut of cuts) {
    if (cut.start > cursor + 0.08) keep.push({ start: cursor, end: cut.start });
    cursor = Math.max(cursor, cut.end);
  }
  if (duration > cursor + 0.08) keep.push({ start: cursor, end: duration });
  if (!keep.length) throw new Error("Aucun passage exploitable n'a été détecté. Réduisez la sensibilité et réessayez.");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-smartcut-"));
  const outputPath = path.join(dir, crypto.randomUUID() + ".mp4");
  const filters = [];
  keep.forEach((part, i) => {
    filters.push("[0:v]trim=start=" + part.start.toFixed(3) + ":end=" + part.end.toFixed(3) + ",setpts=PTS-STARTPTS[v" + i + "]");
    filters.push("[0:a]atrim=start=" + part.start.toFixed(3) + ":end=" + part.end.toFixed(3) + ",asetpts=PTS-STARTPTS[a" + i + "]");
  });
  const concatInputs = keep.map((_, i) => "[v" + i + "][a" + i + "]").join("");
  filters.push(concatInputs + "concat=n=" + keep.length + ":v=1:a=1[outv][outa]");
  const args = [
    "-y", "-hide_banner", "-i", inputPath,
    "-filter_complex", filters.join(";"),
    "-map", "[outv]", "-map", "[outa]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
    "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
    outputPath
  ];
  try {
    await run(ffmpegPath, args);
    const stat = fs.statSync(outputPath);
    if (!stat.size) throw new Error("Le fichier vidéo exporté est vide.");
    const keptSeconds = keep.reduce((sum, part) => sum + part.end - part.start, 0);
    return {
      outputPath, outputDir: dir, duration, keptSeconds,
      removedSeconds: Math.max(0, duration - keptSeconds),
      detectedSilences: detected.length,
      cuts: cuts.map(c => ({ start: Number(c.start.toFixed(2)), end: Number(c.end.toFixed(2)) }))
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
