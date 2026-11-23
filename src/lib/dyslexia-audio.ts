import axios from "axios";

type AudioRiskLevel = "low" | "moderate" | "elevated" | "high";

function levelFor(score: number): AudioRiskLevel {
  if (score >= 80) return "high";
  if (score >= DYSLEXIA_ELEVATED_THRESHOLD) return "elevated";
  if (score >= 40) return "moderate";
  return "low";
}

/** Elevated screening concern starts at this score. Feature scores stay at 0 until that audio crosses its cutoff. */
export const DYSLEXIA_ELEVATED_THRESHOLD = 60;

/** No audio score is shown at 100. The highest result for a recording is between these two values. */
export const DYSLEXIA_SCORE_LIMIT = { minimum: 87, maximum: 91 } as const;

export const DYSLEXIA_FEATURE_CUTOFFS = {
  speechEnergyRatio: 0.35,
  readingRatePerSecond: 2.5,
  slowReadingRatePerSecond: 0.5,
  longPauseSeconds: 0.3,
  longPausesPerMinute: 4,
  markedPausesPerMinute: 18,
  timingVariation: 0.4,
  markedTimingVariation: 1.2,
  hesitationsPerMinute: 3,
  markedHesitationsPerMinute: 15,
} as const;

export const DYSLEXIA_DISCLAIMER =
  "This audio screening result is support for the teacher. It is not a clinical diagnosis.";

export interface DyslexiaSignal {
  label: string;
  detail: string;
  value: number;
}

export interface DyslexiaScreen {
  score: number;
  level: AudioRiskLevel;
  signals: DyslexiaSignal[];
  durationSeconds: number;
  estimatedActivitySeconds: number;
}

export const DYSLEXIA_ACTIVITY_LABEL =
  "estimated audio activity (not reading speed, not verified speech)";

export const DYSLEXIA_EXTENSIONS = [".mp4", ".m4a", ".wav", ".mp3", ".ogg", ".flac", ".aac"] as const;

export const DYSLEXIA_MAX_BYTES = 15 * 1024 * 1024;

export const DYSLEXIA_SERVICE_URL = "http://127.0.0.1:8001";

export interface DyslexiaAudioAnalysis {
  durationSeconds: number;
  estimatedActivitySeconds: number;
  qualityFlags: string[];
}

export function dyslexiaUploadError(file: { name: string; size: number }) {
  const lower = file.name.toLowerCase();
  const allowed = DYSLEXIA_EXTENSIONS.some((extension) => lower.endsWith(extension));
  if (!allowed) return "Upload an audio file: MP4, M4A, WAV, MP3, OGG, FLAC, or AAC.";
  if (file.size > DYSLEXIA_MAX_BYTES) return "Audio files must be 15 MB or smaller.";
  if (file.size <= 0) return "The audio file is empty.";
  return null;
}

export function qualityCheckText(flags: string[]) {
  if (!flags.length) return "No quality warning.";
  return flags.map((flag) => flag.replaceAll("_", " ")).join(", ");
}

function clampScore(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(DYSLEXIA_SCORE_LIMIT.maximum, Math.round(value)));
}

function fractionAbove(value: number, cutoff: number, extreme: number) {
  if (value <= cutoff || extreme <= cutoff) return 0;
  return Math.min(1, (value - cutoff) / (extreme - cutoff));
}

function fractionBelow(value: number, cutoff: number, extreme: number) {
  if (value >= cutoff || extreme >= cutoff) return 0;
  return Math.min(1, (cutoff - value) / (cutoff - extreme));
}

function ceilingFor(fractions: number[]) {
  const strongest = Math.max(0, ...fractions);
  const steps = DYSLEXIA_SCORE_LIMIT.maximum - DYSLEXIA_SCORE_LIMIT.minimum;
  return DYSLEXIA_SCORE_LIMIT.minimum + Math.round(strongest * steps);
}

function pointsFor(fraction: number, ceiling: number) {
  return clampScore(fraction * ceiling);
}

export function scoreSamples(samples: Float32Array, sampleRate: number): DyslexiaScreen {
  const rate = sampleRate > 0 ? sampleRate : 16000;
  const durationSeconds = samples.length / rate;
  const frame = Math.max(1, Math.floor(rate * 0.02));
  const hop = Math.max(1, Math.floor(rate * 0.005));
  const rms: number[] = [];
  for (let index = 0; index + frame <= samples.length; index += hop) {
    let sum = 0;
    for (let offset = 0; offset < frame; offset += 1) {
      const sample = samples[index + offset];
      sum += sample * sample;
    }
    rms.push(Math.sqrt(sum / frame));
  }

  const sorted = [...rms].sort((left, right) => left - right);
  const loud = sorted[Math.max(sorted.length - 1, 0)] > 0
    ? sorted[Math.floor(sorted.length * 0.9)] ?? 0
    : 0;
  const threshold = loud <= 0.008 ? 0.008 : Math.max(0.008, loud * DYSLEXIA_FEATURE_CUTOFFS.speechEnergyRatio);
  const voiced = rms.map((energy) => energy >= threshold);
  const voicedFrames = voiced.filter(Boolean).length;
  const estimatedActivitySeconds = (voicedFrames * hop) / rate;

  const smooth = rms.map((_, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -4; offset <= 4; offset += 1) {
      const energy = rms[index + offset];
      if (energy !== undefined) {
        sum += energy;
        count += 1;
      }
    }
    return count ? sum / count : 0;
  });
  const valleyWindow = Math.max(1, Math.round(0.08 / (hop / rate)));
  const candidates: number[] = [];
  for (let index = 1; index < smooth.length - 1; index += 1) {
    const energy = smooth[index];
    if (energy < threshold || energy < smooth[index - 1] || energy <= smooth[index + 1]) continue;
    let leftMin = energy;
    let rightMin = energy;
    for (let offset = 1; offset <= valleyWindow; offset += 1) {
      if (index - offset >= 0) leftMin = Math.min(leftMin, smooth[index - offset]);
      if (index + offset < smooth.length) rightMin = Math.min(rightMin, smooth[index + offset]);
    }
    const valley = Math.max(leftMin, rightMin);
    if (energy < valley * 1.35 || energy - valley < threshold * 0.25) continue;
    candidates.push(index);
  }
  const minPeakGap = Math.max(1, Math.round(0.15 / (hop / rate)));
  const peaks: number[] = [];
  for (const candidate of candidates) {
    const previous = peaks[peaks.length - 1];
    if (previous === undefined || candidate - previous >= minPeakGap) {
      peaks.push(candidate);
      continue;
    }
    if (smooth[candidate] > smooth[previous]) peaks[peaks.length - 1] = candidate;
  }

  const segments: { start: number; end: number; voiced: boolean }[] = [];
  let start = 0;
  for (let index = 1; index <= voiced.length; index += 1) {
    if (index === voiced.length || voiced[index] !== voiced[start]) {
      segments.push({ start, end: index, voiced: voiced[start] });
      start = index;
    }
  }
  const seconds = (segment: { start: number; end: number }) => ((segment.end - segment.start) * hop) / rate;
  let syllables = 0;
  for (const segment of segments) {
    if (!segment.voiced || seconds(segment) < 0.08) continue;
    const segmentPeaks = peaks.filter((peak) => peak >= segment.start && peak < segment.end).length;
    const fromLength = Math.max(1, Math.round(seconds(segment) / 0.22));
    syllables += segmentPeaks > 0 ? segmentPeaks : fromLength;
  }
  const syllablesPerSecond = durationSeconds > 0 ? syllables / durationSeconds : 0;
  const pauses = segments.filter((segment, index) => {
    if (segment.voiced || seconds(segment) < DYSLEXIA_FEATURE_CUTOFFS.longPauseSeconds) return false;
    const edge = index === 0 || index === segments.length - 1;
    return !(edge && seconds(segment) < 0.8);
  });
  const pausesPerMinute = durationSeconds > 0 ? (pauses.length / durationSeconds) * 60 : 0;

  const events: number[] = [];
  for (const segment of segments) {
    if (!segment.voiced || seconds(segment) < 0.08) continue;
    const segmentPeaks = peaks.filter((peak) => peak >= segment.start && peak < segment.end);
    if (segmentPeaks.length) {
      for (const peak of segmentPeaks) events.push((peak * hop) / rate);
    } else {
      events.push((((segment.start + segment.end) / 2) * hop) / rate);
    }
  }
  const gaps: number[] = [];
  for (let index = 1; index < events.length; index += 1) gaps.push(events[index] - events[index - 1]);
  const meanGap = gaps.length ? gaps.reduce((total, gap) => total + gap, 0) / gaps.length : 0;
  const variance = gaps.reduce((total, gap) => total + (gap - meanGap) ** 2, 0);
  const spread = gaps.length > 1 ? Math.sqrt(variance / (gaps.length - 1)) : 0;
  const timingVariation = meanGap > 0 ? spread / meanGap : 0;
  let hesitations = 0;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const current = segments[index];
    const next = segments[index + 1];
    if (current.voiced && seconds(current) <= 0.28 && !next.voiced && seconds(next) >= DYSLEXIA_FEATURE_CUTOFFS.longPauseSeconds) {
      hesitations += 1;
    }
  }
  const hesitationsPerMinute = durationSeconds > 0 ? (hesitations / durationSeconds) * 60 : 0;
  const timingFraction = gaps.length < 2 ? 0 : fractionAbove(timingVariation, DYSLEXIA_FEATURE_CUTOFFS.timingVariation, DYSLEXIA_FEATURE_CUTOFFS.markedTimingVariation);
  const fractions = [
    fractionBelow(syllablesPerSecond, DYSLEXIA_FEATURE_CUTOFFS.readingRatePerSecond, DYSLEXIA_FEATURE_CUTOFFS.slowReadingRatePerSecond),
    fractionAbove(pausesPerMinute, DYSLEXIA_FEATURE_CUTOFFS.longPausesPerMinute, DYSLEXIA_FEATURE_CUTOFFS.markedPausesPerMinute),
    timingFraction,
    fractionAbove(hesitationsPerMinute, DYSLEXIA_FEATURE_CUTOFFS.hesitationsPerMinute, DYSLEXIA_FEATURE_CUTOFFS.markedHesitationsPerMinute),
  ];
  const ceiling = ceilingFor(fractions);
  const measured = [
    `${syllablesPerSecond.toFixed(2)} syllables/sec during speech. Cutoff is 2.50.`,
    `${pausesPerMinute.toFixed(1)} long pauses/min. Cutoff is 4.0.`,
    `${timingVariation.toFixed(2)} gap variation. Cutoff is 0.40.`,
    `${hesitationsPerMinute.toFixed(1)} hesitations/min. Cutoff is 3.0.`,
  ];
  const labels = ["Reading rate", "Pause frequency", "Word timing", "Hesitations"];
  const signals: DyslexiaSignal[] = fractions.map((fraction, index) => ({
    label: labels[index],
    value: pointsFor(fraction, ceiling),
    detail: measured[index],
  }));

  const weighted = fractions[0] * 0.35 + fractions[1] * 0.25 + fractions[2] * 0.2 + fractions[3] * 0.2;
  const score = Math.min(pointsFor(weighted, ceiling), ceiling);
  return { score, level: levelFor(score), signals, durationSeconds, estimatedActivitySeconds };
}

function downsample(samples: Float32Array, fromRate: number) {
  const target = 16000;
  if (fromRate <= target) return { samples, sampleRate: fromRate };
  const ratio = fromRate / target;
  const length = Math.floor(samples.length / ratio);
  const reduced = new Float32Array(length);
  for (let index = 0; index < length; index += 1) reduced[index] = samples[Math.floor(index * ratio)];
  return { samples: reduced, sampleRate: target };
}

function samplesFromBytes(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  const start = Math.min(44, view.length);
  const samples = new Float32Array(Math.max(view.length - start, 1));
  for (let index = start; index < view.length; index += 1) samples[index - start] = (view[index] - 128) / 128;
  return samples;
}

export async function scoreDyslexiaFile(file: File): Promise<DyslexiaScreen> {
  const bytes = await file.arrayBuffer();
  if (typeof AudioContext !== "undefined") {
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(bytes.slice(0));
      const channel = audio.getChannelData(0);
      const copy = new Float32Array(channel.length);
      copy.set(channel);
      const reduced = downsample(copy, audio.sampleRate);
      return scoreSamples(reduced.samples, reduced.sampleRate);
    } catch {
      return scoreSamples(samplesFromBytes(bytes), 16000);
    } finally {
      await context.close();
    }
  }
  return scoreSamples(samplesFromBytes(bytes), 16000);
}

export function dyslexiaExplanation(signals: DyslexiaSignal[], score: number) {
  const crossed = signals.filter((signal) => signal.value > 0);
  const summary = crossed.length
    ? crossed.map((signal) => signal.label.toLowerCase()).join(", ")
    : "none of the audio features";
  const band = score >= DYSLEXIA_ELEVATED_THRESHOLD ? "at or above" : "below";
  return `This recording scored ${score}%. Elevated screening concern starts at ${DYSLEXIA_ELEVATED_THRESHOLD}. The score is ${band} that threshold because of ${summary}.`;
}

export function publicDyslexiaResult(payload: Record<string, unknown>): DyslexiaAudioAnalysis {
  const flags = Array.isArray(payload.quality_flags)
    ? payload.quality_flags.filter((flag): flag is string => typeof flag === "string")
    : [];
  return {
    durationSeconds: Number(payload.duration_seconds),
    estimatedActivitySeconds: Number(payload.estimated_activity_seconds),
    qualityFlags: flags,
  };
}

function serviceHint() {
  return (process.env.NEXT_PUBLIC_DYSLEXIA_API_URL || DYSLEXIA_SERVICE_URL).replace(/\/$/, "");
}

export async function analyzeDyslexiaAudio(file: File): Promise<DyslexiaAudioAnalysis> {
  const form = new FormData();
  form.append("file", file, file.name);
  const base = (process.env.NEXT_PUBLIC_DYSLEXIA_API_URL || "").replace(/\/$/, "");
  try {
    const response = await axios.post(`${base}/api/dyslexia/analyze`, form, { timeout: 30000 });
    const payload = response.data as Record<string, unknown>;
    if (payload.dyslexia_prediction_available !== false) {
      throw new Error("The analysis model is not loaded on the server.");
    }
    const result = publicDyslexiaResult(payload);
    if (!Number.isFinite(result.durationSeconds) || !Number.isFinite(result.estimatedActivitySeconds)) {
      throw new Error("The audio file could not be analysed.");
    }
    return result;
  } catch (error) {
    if (error instanceof Error && !axios.isAxiosError(error)) throw error;
    if (axios.isAxiosError(error)) {
      if (!error.response || error.code === "ECONNABORTED") {
        throw new Error(`Cannot reach the analysis server. Make sure the backend is running at ${serviceHint()}.`);
      }
      const status = error.response.status;
      const detail = error.response.data && typeof error.response.data === "object" && "detail" in error.response.data
        ? String((error.response.data as { detail?: unknown }).detail ?? "")
        : "";
      if (status === 503) throw new Error("The analysis model is not loaded on the server.");
      if ((status === 413 || status === 415 || status === 422 || status === 400) && detail) throw new Error(detail);
      throw new Error(detail || "Something went wrong while analysing the audio.");
    }
    throw new Error("Something went wrong while analysing the audio.");
  }
}
