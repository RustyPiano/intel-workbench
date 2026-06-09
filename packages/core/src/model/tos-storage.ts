import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import path from "node:path";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

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
  const client = new S3Client({
    region: config.region,
    endpoint: resolveS3Endpoint(config.endpoint, config.region),
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.accessKeySecret,
    },
    // TOS only accepts virtual-host-style requests over the S3 protocol.
    forcePathStyle: false,
    // TOS does not support the AWS flexible (aws-chunked / x-amz-checksum-*)
    // integrity scheme that newer SDKs send by default, so keep it opt-in.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  return {
    async putObjectFromFile({ bucket, key, filePath, contentType }) {
      const body = createReadStream(filePath);
      try {
        const upload = new Upload({
          client,
          params: {
            Bucket: bucket,
            Key: key,
            Body: body,
            ...(contentType ? { ContentType: contentType } : {}),
          },
        });
        await upload.done();
      } finally {
        // lib-storage closes the stream on a clean run; destroy it explicitly so
        // a failed/aborted upload cannot leak the file descriptor.
        body.destroy();
      }
    },
    getPreSignedUrl({ bucket, key, expires }) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
        expiresIn: expires,
      });
    },
  };
}

// TOS exposes a dedicated S3-protocol host (`tos-s3-<region>...`) that differs
// from the native TOS host (`tos-<region>...`). Derive it from the region when
// no endpoint is set, and transparently upgrade a native Volcano host so an
// existing `MINI_AGENT_TOS_ENDPOINT` keeps working after the S3 migration.
export function resolveS3Endpoint(endpoint: string | undefined, region: string): string {
  const trimmed = endpoint?.trim();
  if (!trimmed) {
    return `https://tos-s3-${region}.volces.com`;
  }

  let host: string;
  try {
    host = new URL(/^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`).host;
  } catch {
    host = trimmed.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");
  }

  const s3Host = host.replace(/^tos-(?!s3-)(.*\.i?volces\.com)$/iu, "tos-s3-$1");
  return `https://${s3Host}`;
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
