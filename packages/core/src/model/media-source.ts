import path from "node:path";

import { RuntimeError } from "../runtime/errors.js";

export const MEDIA_KINDS = ["video", "audio", "image"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const AUDIO_FORMATS = [
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "wma",
  "amr",
  "3gp",
  "3gpp",
  "webm",
] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export type UrlMediaSource =
  | { type: "url"; url: string; kind: "video" }
  | { type: "url"; url: string; kind: "image" }
  | { type: "url"; url: string; kind: "audio"; format: string };

export type FileMediaSource = { type: "file"; path: string };
export type MediaSource = FileMediaSource | UrlMediaSource;

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv", ".mpeg", ".mpg"]);
const AUDIO_EXTENSIONS = new Set(AUDIO_FORMATS.map((format) => `.${format}`));
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".m4v": "video/x-m4v",
  ".flv": "video/x-flv",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".wma": "audio/x-ms-wma",
  ".amr": "audio/amr",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function isSupportedAudioUrlFormat(format: string): boolean {
  return (AUDIO_FORMATS as readonly string[]).includes(format.toLowerCase());
}

export function detectMediaKind(filePath: string): MediaKind {
  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }

  throw new RuntimeError({
    code: "INVALID_ARGS",
    message: `Unsupported media file extension: ${ext || "(none)"}. Supported: video, audio, image.`,
  });
}

export function mediaMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}
