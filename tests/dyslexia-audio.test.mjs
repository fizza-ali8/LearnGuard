import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const disclaimer = "This audio screening result is support for the teacher. It is not a clinical diagnosis.";
const flow = fs.readFileSync(path.join(root, "src/components/assessment/dyslexia-flow.tsx"), "utf8");
const result = fs.readFileSync(path.join(root, "src/components/results/result-view.tsx"), "utf8");
const libSource = fs.readFileSync(path.join(root, "src/lib/dyslexia-audio.ts"), "utf8");
const api = fs.readFileSync(path.join(root, "backend/dyslexia/api/app.py"), "utf8");

assert.match(libSource, new RegExp(disclaimer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(flow, /DYSLEXIA_DISCLAIMER/);
assert.match(result, /DYSLEXIA_DISCLAIMER/);
assert.equal(flow.includes("research_audio_features"), false);
assert.equal(flow.includes("runAssessment"), false);
assert.equal(flow.includes("Dyslexia detected"), false);
assert.equal(flow.includes("Probability"), false);
assert.match(flow, /scoreDyslexiaFile/);
assert.match(flow, /result\.signals/);
assert.match(libSource, /Reading rate/);
assert.match(libSource, /export function scoreSamples/);
assert.equal(libSource.includes("estimated audio activity (not reading speed, not verified speech)"), true);
assert.equal(api.includes("joblib"), false);
assert.match(api, /unlink\(missing_ok=True\)/);

const moduleUrl = pathToFileURL(path.join(root, "src/lib/dyslexia-audio.ts")).href;
const lib = await import(moduleUrl);
assert.equal(lib.DYSLEXIA_DISCLAIMER, disclaimer);
assert.equal(lib.dyslexiaUploadError({ name: "notes.txt", size: 10 }), "Upload an audio file: MP4, M4A, WAV, MP3, OGG, FLAC, or AAC.");
assert.equal(lib.dyslexiaUploadError({ name: "big.wav", size: 15 * 1024 * 1024 + 1 }), "Audio files must be 15 MB or smaller.");
assert.equal(lib.dyslexiaUploadError({ name: "empty.wav", size: 0 }), "The audio file is empty.");
assert.equal(lib.dyslexiaUploadError({ name: "reading.m4a.mp4", size: 1200 }), null);
const shown = lib.publicDyslexiaResult({
  duration_seconds: 2.5,
  estimated_activity_seconds: 1.2,
  quality_flags: ["very_short_recording"],
  research_audio_features: { mfcc_2_mean: 1 },
  dyslexia_prediction_available: false,
});
assert.deepEqual(Object.keys(shown).sort(), ["durationSeconds", "estimatedActivitySeconds", "qualityFlags"]);
assert.equal(JSON.stringify(shown).includes("mfcc"), false);

function tone(seconds, bursts) {
  const sampleRate = 16000;
  const samples = new Float32Array(sampleRate * seconds);
  const burst = Math.floor(sampleRate * 0.18);
  const gap = Math.floor((sampleRate * seconds) / bursts);
  for (let index = 0; index < bursts; index += 1) {
    const start = index * gap;
    for (let offset = 0; offset < burst && start + offset < samples.length; offset += 1) {
      samples[start + offset] = Math.sin((2 * Math.PI * 180 * offset) / sampleRate) * 0.5;
    }
  }
  return samples;
}

const fluent = lib.scoreSamples(tone(4, 16), 16000);
const mid = lib.scoreSamples(tone(4, 8), 16000);
const hesitant = lib.scoreSamples(tone(4, 4), 16000);
assert.equal(fluent.signals.length, 4);
assert.equal(hesitant.signals.map((signal) => signal.label).join(","), "Reading rate,Pause frequency,Word timing,Hesitations");
assert.equal(lib.DYSLEXIA_ELEVATED_THRESHOLD, 60);
assert.ok(fluent.score < 40, `expected fluent ${fluent.score} under the moderate band`);
assert.ok(mid.score > fluent.score && mid.score < hesitant.score, `expected fluent ${fluent.score} < mid ${mid.score} < hesitant ${hesitant.score}`);
assert.ok(hesitant.score >= lib.DYSLEXIA_ELEVATED_THRESHOLD, `expected hesitant ${hesitant.score} at or above ${lib.DYSLEXIA_ELEVATED_THRESHOLD}`);
assert.ok(hesitant.score <= lib.DYSLEXIA_SCORE_LIMIT.maximum);
for (const signal of [...fluent.signals, ...mid.signals, ...hesitant.signals]) {
  assert.ok(signal.value <= lib.DYSLEXIA_SCORE_LIMIT.maximum, `${signal.label} scored ${signal.value}`);
  assert.match(signal.detail, /Cutoff is/);
}
console.log("dyslexia frontend checks passed");
