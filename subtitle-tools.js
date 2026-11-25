import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const MAX_SUBTITLE_CUES = 12000;

function timestampToSeconds(value) {
  const normalized = String(value || "").trim().replace(",", ".");
  const match = normalized.match(/^(?:(\d{1,2}):(\d{2}):(\d{2})|(\d{2}):(\d{2}))\\.(\d{1,3})$/);
  if (!match) return NaN;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[1] === undefined ? match[4] : match[2]);
  const seconds = Number(match[1] === undefined ? match[5] : match[3]);
  const millis = Number((match[6] + "00").slice(0, 3));
  if (minutes > 59 || seconds > 59) return NaN;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

function secondsToTimestamp(value, separator = ",") {
  const ms = Math.max(0, Math.round(Number(value) * 1000));
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;
  return [String(hours).padStart(2, "0"), String(minutes).padStart(2, "0"), String(seconds).padStart(2, "0")].join(":") + separator + String(millis).padStart(3, "0");
}

export function parseSubtitleText(input, format = "auto") {
  const source = String(input || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!source.trim()) throw new Error("Le fichier de sous-titres est vide.");
  if (Buffer.byteLength(source, "utf8") > MAX_SUBTITLE_BYTES) throw new Error("Le fichier de sous-titres dépasse 5 Mo.");
  const isVtt = format === "vtt" || (format === "auto" && /^\s*WEBVTT(?:\s|$)/i.test(source));
  const body = isVtt ? source.replace(/^\s*WEBVTT[^\n]*\n/i, "") : source;
  const blocks = body.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n").map(line => line.trimEnd());
    const timeIndex = lines.findIndex(line => line.includes("-->"));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex].match(/^\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}\s+-->\s+(\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}(?:\s+.*)?$/);
    if (!match) continue;
    const times = lines[timeIndex].split("-->");
    const start = timestampToSeconds(times[0].trim());
    const endToken = times[1].trim().split(/\s+/)[0];
    const end = timestampToSeconds(endToken);
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) continue;
    cues.push({ start, end, text: text.slice(0, 4000) });
    if (cues.length > MAX_SUBTITLE_CUES) throw new Error("Le fichier contient plus de 12 000 sous-titres.");
  }
  if (!cues.length) throw new Error("Aucun sous-titre valide détecté. Vérifiez le format SRT ou VTT.");
  return { format: isVtt ? "vtt" : "srt", cues };
}

export function serializeSubtitleText(cues, format = "srt") {
  if (!Array.isArray(cues) || !cues.length || cues.length > MAX_SUBTITLE_CUES) throw new Error("La liste de sous-titres est invalide.");
  const isVtt = String(format).toLowerCase() === "vtt";
  const blocks = cues.map((cue, index) => {
    const start = Number(cue.start), end = Number(cue.end);
    const text = String(cue.text || "").trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text || text.length > 4000) {
      throw new Error("Un sous-titre contient un minutage ou un texte invalide.");
    }
    const timing = secondsToTimestamp(start, isVtt ? "." : ",") + " --> " + secondsToTimestamp(end, isVtt ? "." : ",");
    return (isVtt ? "" : String(index + 1) + "\n") + timing + "\n" + text;
  });
  return (isVtt ? "WEBVTT\n\n" : "") + blocks.join("\n\n") + "\n";
}

function run(binary, args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("L'analyse vidéo a dépassé le délai autorisé.")); }, timeoutMs);
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-30000); });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0 || /Input #0|Stream #\d+:\d+/.test(stderr)) resolve(stderr);
      else reject(new Error("Impossible d'analyser cette vidéo. " + stderr.slice(-1200)));
    });
  });
}

export async function inspectSubtitleStreams(inputPath) {
  if (!ffmpegPath) throw new Error("FFmpeg n'est pas disponible.");
  const log = await run(ffmpegPath, ["-hide_banner", "-i", inputPath]);
  const streams = [];
  const re = /Stream #0:(\d+)(?:\(([^)]*)\))?: Subtitle: ([^,\n]+)/g;
  let match;
  while ((match = re.exec(log))) {
    streams.push({ index: Number(match[1]), language: match[2] || "und", codec: match[3].trim() });
  }
  return { streams, hasSubtitleTracks: streams.length > 0 };
}

export async function removeSubtitleStreams(inputPath) {
  if (!ffmpegPath) throw new Error("FFmpeg n'est pas disponible.");
  const ext = path.extname(inputPath).toLowerCase() || ".mp4";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-subtitle-clean-"));
  const outputPath = path.join(dir, "justevivo-clean-video" + ext);
  try {
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-i", inputPath,
      "-map", "0", "-map", "-0:s",
      "-c", "copy", "-map_metadata", "0", outputPath
    ], 180000);
    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).size) {
      throw new Error("La vidéo sans pistes de sous-titres n'a pas pu être créée.");
    }
    return { outputPath, outputDir: dir, size: fs.statSync(outputPath).size };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function extractSubtitleStream(inputPath, streamIndex, format = "srt") {
  if (!ffmpegPath) throw new Error("FFmpeg n'est pas disponible.");
  const index = Number(streamIndex);
  if (!Number.isInteger(index) || index < 0 || index > 100) throw new Error("Piste de sous-titres invalide.");
  const ext = String(format).toLowerCase() === "vtt" ? "webvtt" : "srt";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-subtitle-"));
  const outputPath = path.join(dir, crypto.randomUUID() + (ext === "srt" ? ".srt" : ".vtt"));
  try {
    await run(ffmpegPath, ["-y", "-hide_banner", "-i", inputPath, "-map", "0:" + index, "-c:s", ext, outputPath], 90000);
    if (!fs.existsSync(outputPath) || !fs.statSync(outputPath).size) throw new Error("Cette piste ne peut pas être extraite en texte SRT/VTT.");
    return { outputPath, outputDir: dir };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
