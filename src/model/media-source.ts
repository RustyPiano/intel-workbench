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

export function isSupportedAudioUrlFormat(format: string): boolean {
  return (AUDIO_FORMATS as readonly string[]).includes(format.toLowerCase());
}
