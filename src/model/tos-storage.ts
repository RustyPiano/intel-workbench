import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import TOS from "@volcengine/tos-sdk";

import { RuntimeError } from "../runtime/errors.js";
import type { TosStorageConfig } from "../tools/types.js";

export interface PublishedMedia {
  url: string;
  bucket: string;
  key: string;
  expiresSeconds: number;
  sizeBytes: number;
}

export type PublishedMediaMetadata = Omit<PublishedMedia, "url">;

export interface TosStorageClient {
  putObjectFromFile(input: {
    bucket?: string;
    key: string;
    filePath: string;
    contentType?: string;
  }): Promise<unknown>;
  getPreSignedUrl(input: {
    bucket?: string;
    key: string;
    method: "GET";
    expires: number;
  }): string | Promise<string>;
}

export interface PublishFileToTosParams {
  config: TosStorageConfig;
  filePath: string;
  runId: string;
  toolCallId: string;
  contentType?: string;
  client?: TosStorageClient;
}

type TosConstructor = new (options: {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  region: string;
  endpoint?: string;
}) => TosStorageClient;

export async function publishFileToTos(params: PublishFileToTosParams): Promise<PublishedMedia> {
  const { config, filePath, runId, toolCallId, contentType } = params;
  const bucket = config.bucket;
  const key = buildObjectKey(config.prefix, runId, toolCallId, filePath);
  const expiresSeconds = config.signedUrlExpires;
  const file = await getReadableFileStats(filePath);

  try {
    const client = params.client ?? createTosClient(config);
    const putInput = {
      bucket,
      key,
      filePath,
      ...(contentType ? { contentType } : {}),
    };

    await client.putObjectFromFile(putInput);
    const url = await client.getPreSignedUrl({
      bucket,
      key,
      method: "GET",
      expires: expiresSeconds,
    });

    return {
      url,
      bucket,
      key,
      expiresSeconds,
      sizeBytes: file.size,
    };
  } catch (error) {
    throw toTosRuntimeError(error);
  }
}

export function toPublishedMediaMetadata(media: PublishedMedia): PublishedMediaMetadata {
  return {
    bucket: media.bucket,
    key: media.key,
    expiresSeconds: media.expiresSeconds,
    sizeBytes: media.sizeBytes,
  };
}

function createTosClient(config: TosStorageConfig): TosStorageClient {
  const Client = TOS as unknown as TosConstructor;
  return new Client({
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
    bucket: config.bucket,
    region: config.region,
    endpoint: normalizeEndpointForSdk(config.endpoint),
  });
}

function normalizeEndpointForSdk(endpoint: string | undefined): string | undefined {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed).host;
  } catch {
    return trimmed.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  }
}

function buildObjectKey(prefix: string, runId: string, toolCallId: string, filePath: string): string {
  const segments = [normalizePrefix(prefix), sanitizeKeySegment(runId), sanitizeKeySegment(toolCallId)].filter(
    (segment) => segment.length > 0,
  );
  const timestamp = String(Date.now());
  const baseName = sanitizeBaseName(path.basename(filePath));
  return [...segments, `${timestamp}-${baseName}`].join("/");
}

function normalizePrefix(prefix: string): string {
  return prefix
    .split("/")
    .map((segment) => sanitizeKeySegment(segment))
    .filter((segment) => segment.length > 0)
    .join("/");
}

function sanitizeKeySegment(segment: string): string {
  return segment.trim().replace(/[\u0000-\u001f\u007f/\\]+/gu, "_");
}

function sanitizeBaseName(baseName: string): string {
  const sanitized = sanitizeKeySegment(baseName).replace(/^\.+$/u, "");
  return sanitized.length > 0 ? sanitized : "file";
}

async function getReadableFileStats(filePath: string): Promise<Stats> {
  try {
    const file = (await stat(filePath)) as Stats;
    if (!file.isFile()) {
      throw new RuntimeError({
        code: "INVALID_ARGS",
        message: `Cannot publish local media to TOS because the path is not a file: ${filePath}`,
        details: {
          category: "file",
          path: filePath,
        },
      });
    }
    return file;
  } catch (error) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown file access error";
    throw new RuntimeError({
      code: "INVALID_ARGS",
      message: `Cannot read local media file for TOS upload: ${filePath}: ${message}`,
      details: {
        category: "file",
        path: filePath,
        cause: message,
      },
    });
  }
}

function toTosRuntimeError(error: unknown): RuntimeError {
  if (error instanceof RuntimeError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "Unknown TOS storage error";
  return new RuntimeError({
    code: "MODEL_ERROR",
    message: `Failed to publish media to TOS: ${message}`,
    details: {
      category: "tos",
      cause: message,
    },
  });
}
