import test from "node:test";
import assert from "node:assert/strict";
import { parseSubtitleText, serializeSubtitleText } from "../subtitle-tools.js";

test("parse un fichier SRT et conserve les minutages", () => {
  const input = "1\n00:00:01,250 --> 00:00:02,500\nBonjour\n\n2\n00:00:03,000 --> 00:00:04,000\nLe monde";
  const parsed = parseSubtitleText(input);
  assert.equal(parsed.format, "srt");
  assert.equal(parsed.cues.length, 2);
  assert.equal(parsed.cues[0].start, 1.25);
  assert.equal(parsed.cues[0].end, 2.5);
  assert.equal(parsed.cues[1].text, "Le monde");
});

test("parse un fichier WebVTT avec réglages de cue", () => {
  const input = "WEBVTT\n\n00:01.000 --> 00:02.500 align:start\nHello";
  const parsed = parseSubtitleText(input);
  assert.equal(parsed.format, "vtt");
  assert.equal(parsed.cues[0].start, 1);
  assert.equal(parsed.cues[0].text, "Hello");
});

test("exporte en SRT et VTT sans changer les timings", () => {
  const cues = [{ start: 1.25, end: 2.5, text: "Bonjour" }];
  const srt = serializeSubtitleText(cues, "srt");
  const vtt = serializeSubtitleText(cues, "vtt");
  assert.match(srt, /00:00:01,250 --> 00:00:02,500/);
  assert.match(vtt, /WEBVTT/);
  assert.match(vtt, /00:00:01\.250 --> 00:00:02\.500/);
  assert.equal(parseSubtitleText(srt).cues[0].text, "Bonjour");
  assert.equal(parseSubtitleText(vtt).cues[0].text, "Bonjour");
});

test("rejette un fichier vide et un minutage invalide", () => {
  assert.throws(() => parseSubtitleText("   "), /vide/);
  assert.throws(() => serializeSubtitleText([{ start: 3, end: 2, text: "Invalide" }]), /invalide/);
});
