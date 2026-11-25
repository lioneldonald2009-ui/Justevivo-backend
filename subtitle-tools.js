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
  const match = normalized.match(/^(?:(\d{1,2}):(\d{2}):(\d{2})|(\d{2}):(\d{2}))\.(\d{1,3})$/);
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
    const match = lines[timeIndex].match(/^\s*(?:(?:\d{1,2}:)?\d{2}:\d{2}|\d{2}:\d{2})[.,]\d{1,3}\s+-->\s+(?:(?:\d{1,2}:)?\d{2}:\d{2}|\d{2}:\d{2})[.,]\d{1,3}(?:\s+.*)?$/);
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


// Extraction d'images représentatives pour la reconnaissance OCR des sous-titres incrustés.
export async function extractFramesForSubtitleOcr(inputPath, options = {}) {
  if (!ffmpegPath) throw new Error("FFmpeg n'est pas disponible.");
  const probe = await run(ffmpegPath, ["-hide_banner", "-i", inputPath]).catch(error => {
    const log = String(error.message || "");
    if (/Duration:/.test(log)) return log;
    throw error;
  });
  const durationMatch = probe.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const sizeMatch = probe.match(/,\s*(\d{2,5})x(\d{2,5})(?:[\s,])/);
  if (!durationMatch || !sizeMatch) throw new Error("Impossible de lire la durée ou les dimensions de la vidéo.");
  const duration = Number(durationMatch[1])*3600 + Number(durationMatch[2])*60 + Number(durationMatch[3]);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) {
    throw new Error("L'analyse OCR accepte les vidéos de 30 minutes maximum.");
  }
  const maxFrames = Math.max(30, Math.min(450, Number(options.maxFrames) || 360));
  const fps = Math.min(0.8, maxFrames / duration);
  const interval = 1 / fps;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-subtitle-ocr-"));
  const pattern = path.join(dir, "frame-%05d.jpg");
  try {
    await run(ffmpegPath, [
      "-y", "-hide_banner", "-i", inputPath, "-an", "-sn",
      "-vf", "fps=" + fps.toFixed(5) + ",scale='min(1280,iw)':-2",
      "-q:v", "5", "-frames:v", String(maxFrames), pattern
    ], 5 * 60 * 1000);
    const files = fs.readdirSync(dir).filter(name => /^frame-\d+\.jpg$/.test(name)).sort();
    if (!files.length) throw new Error("Aucune image exploitable n'a été extraite de la vidéo.");
    return {
      dir,
      duration,
      width: Number(sizeMatch[1]),
      height: Number(sizeMatch[2]),
      fps,
      interval,
      frames: files.map((name, index) => ({
        path: path.join(dir, name),
        time: Math.min(duration, index / fps)
      }))
    };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

// Remplacement de sous-titres incrustés (pixels) : nettoyage local du bandeau
// avec FFmpeg delogo, puis rendu des nouveaux textes aux minutages fournis.
// La zone est volontairement choisie par l'utilisateur pour éviter d'effacer
// une partie de l'image par une détection OCR incertaine.
export async function replaceBurnedInSubtitles(inputPath, cues, region, options = {}) {
  if (!ffmpegPath) throw new Error("FFmpeg n'est pas disponible.");
  if (!Array.isArray(cues) || !cues.length || cues.length > 300) {
    throw new Error("Ajoutez au moins un sous-titre valide (300 maximum).");
  }
  const xPct = Number(region?.x), yPct = Number(region?.y);
  const wPct = Number(region?.width), hPct = Number(region?.height);
  if (![xPct,yPct,wPct,hPct].every(Number.isFinite) ||
      xPct < 0 || yPct < 0 || wPct <= 0 || hPct <= 0 ||
      xPct + wPct > 1 || yPct + hPct > 1 || wPct > 0.95 || hPct > 0.5) {
    throw new Error("Zone invalide. Définissez x, y, largeur et hauteur entre 0 et 100 %.");
  }
  const color = /^#[0-9a-f]{6}$/i.test(String(options.color || "")) ? options.color : "#ffffff";
  const boxColor = /^#[0-9a-f]{6}$/i.test(String(options.boxColor || "")) ? options.boxColor : "#000000";
  const opacity = Math.max(0, Math.min(1, Number(options.boxOpacity ?? 0.55)));
  const probe = await run(ffmpegPath, ["-hide_banner", "-i", inputPath]).catch(error => {
    const log = String(error.message || "");
    if (/Duration:/.test(log)) return log;
    throw error;
  });
  const durationMatch = probe.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const sizeMatch = probe.match(/,\s*(\d{2,5})x(\d{2,5})(?:[\s,])/);
  if (!durationMatch || !sizeMatch) throw new Error("Impossible de lire les dimensions ou la durée de la vidéo.");
  const duration = Number(durationMatch[1])*3600 + Number(durationMatch[2])*60 + Number(durationMatch[3]);
  const width = Number(sizeMatch[1]), height = Number(sizeMatch[2]);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 1800) throw new Error("La vidéo doit durer au maximum 30 minutes.");
  const x = Math.round(width*xPct), y = Math.round(height*yPct);
  const w = Math.max(24, Math.round(width*wPct)), h = Math.max(18, Math.round(height*hPct));
  if (x+w > width || y+h > height) throw new Error("La zone dépasse les dimensions de la vidéo.");
  const cleanCues = cues.map(c => ({
    start:Number(c.start), end:Number(c.end), text:String(c.text || "").trim().slice(0,1000)
  })).filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) &&
    c.start >= 0 && c.end > c.start && c.end <= duration + 0.25 && c.text);
  if (!cleanCues.length) throw new Error("Aucun sous-titre avec un texte et un minutage valides.");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jv-burned-subtitles-"));
  const outputPath = path.join(dir, "justevivo-sous-titres-remplaces.mp4");
  const escapeXml = value => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const wrapText = (value, maxChars) => {
    const result = [];
    String(value).split(/\n/).forEach(paragraph => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      let line = "";
      words.forEach(word => {
        const candidate = line ? line + " " + word : word;
        if (line && candidate.length > maxChars) { result.push(line); line = word; }
        else line = candidate;
      });
      if (line) result.push(line);
    });
    return result.length ? result : [""];
  };
  try {
    const sharpModule = await import("sharp");
    const sharp = sharpModule.default || sharpModule;
    const fontSize = Math.max(14, Math.min(72, Math.round(h*0.34)));
    const lineHeight = Math.round(fontSize*1.2);
    const maxChars = Math.max(12, Math.floor((w*0.9)/(fontSize*0.55)));
    const args = ["-y","-hide_banner","-i",inputPath];
    const filters = [];
    const eraseWindow = cleanCues.map(c => "between(t,"+c.start.toFixed(3)+","+c.end.toFixed(3)+")").join("+");
    filters.push("[0:v]delogo=x="+x+":y="+y+":w="+w+":h="+h+":show=0:enable='" + eraseWindow + "'[clean0]");
    let previous = "clean0";
    for (let i = 0; i < cleanCues.length; i++) {
      const cue = cleanCues[i];
      const lines = wrapText(cue.text, maxChars);
      const totalHeight = lines.length * lineHeight;
      const firstBaseline = y + Math.max(fontSize, Math.round((h-totalHeight)/2) + fontSize);
      const tspans = lines.map((line,index) =>
        "<tspan x='" + (x + w/2) + "' y='" + (firstBaseline + index*lineHeight) + "'>" + escapeXml(line) + "</tspan>"
      ).join("");
      const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + width + "' height='" + height + "' viewBox='0 0 " + width + " " + height + "'>" +
        "<rect x='" + x + "' y='" + y + "' width='" + w + "' height='" + h + "' rx='4' fill='" + boxColor + "' fill-opacity='" + opacity.toFixed(2) + "'/>" +
        "<text font-family='Arial, sans-serif' font-size='" + fontSize + "' font-weight='600' fill='" + color + "' text-anchor='middle'>" + tspans + "</text></svg>";
      const overlayPath = path.join(dir, "caption-" + i + ".png");
      await sharp(Buffer.from(svg)).png().toFile(overlayPath);
      args.push("-loop","1","-framerate","30","-i",overlayPath);
      const overlayLabel = "ov" + i;
      const next = "caption" + i;
      filters.push("[" + (i + 1) + ":v]format=rgba[" + overlayLabel + "]");
      filters.push("[" + previous + "][" + overlayLabel + "]overlay=0:0:eof_action=pass:enable='between(t," +
        cue.start.toFixed(3) + "," + cue.end.toFixed(3) + ")'[" + next + "]");
      previous = next;
    }
    args.push("-filter_complex",filters.join(";"),"-map","["+previous+"]","-map","0:a?","-c:v","libx264",
      "-preset","veryfast","-crf","22","-pix_fmt","yuv420p","-c:a","aac","-b:a","160k","-movflags","+faststart",outputPath);
    await run(ffmpegPath,args,20*60*1000);
    const stat = fs.statSync(outputPath);
    if (!stat.size) throw new Error("Le rendu vidéo est vide.");
    return { outputPath, outputDir:dir, size:stat.size, duration, width, height, cues:cleanCues.length };
  } catch(error) {
    fs.rmSync(dir,{recursive:true,force:true});
    throw error;
  }
}
