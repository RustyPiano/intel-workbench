# Configure Volcano Engine TOS For Local Media

Use this only when local media must become reachable by a model service:

- large local video/image files that cannot be sent inline
- local audio for `analyze_audio` on the `standard` engine, which needs a URL

For audio you can often skip TOS entirely: `analyze_audio` with `engine: "turbo"`
sends a local file inline (base64) with no upload, within the turbo limits
(wav/mp3/ogg/opus, ≤2h/≤100MB, no emotion/gender/speech-rate/volume). TOS is
still required for the `standard` audio engine and for large video/image.

You do not need TOS for first startup. Configure the primary model first, then
add multimodal or Doubao ASR as needed. Add TOS only when local media needs an
upload-to-URL path.

## Approach

Keep the TOS bucket private. mini-agent uploads the local media object, creates a
short-lived pre-signed GET URL, and passes that URL to the media provider. Do
not make the bucket public-read for this workflow.

Volcano Engine references:

- TOS service guide: https://www.volcengine.com/docs/6349/74830?lang=zh
- TOS API/function reference: https://www.volcengine.com/docs/6349/74837?lang=zh

## Create The TOS Resources

1. Enable Volcano Engine TOS if it is not already enabled.
2. Create a bucket in the region you want to use.
3. Keep the bucket private.
4. Create or choose an access key with least privilege for the upload prefix.
   It needs permission to upload objects and generate/read objects through
   pre-signed URLs for that prefix.
5. Consider a lifecycle rule for the upload prefix if the bucket stores only
   temporary model inputs.

## Configure mini-agent

Minimal environment variables:

```bash
export MINI_AGENT_TOS_ACCESS_KEY_ID=your-tos-ak
export MINI_AGENT_TOS_ACCESS_KEY_SECRET=your-tos-sk
export MINI_AGENT_TOS_BUCKET=your-bucket
export MINI_AGENT_TOS_REGION=cn-beijing
```

Optional environment variables:

```bash
export MINI_AGENT_TOS_PREFIX=mini-agent/uploads
export MINI_AGENT_TOS_SIGNED_URL_EXPIRES=3600
# Optional only when overriding the region-derived endpoint:
export MINI_AGENT_TOS_ENDPOINT=tos-s3-cn-beijing.volces.com
```

mini-agent talks to TOS over its S3-compatible protocol. If
`MINI_AGENT_TOS_ENDPOINT` is omitted, the upload client derives the S3 host from
`MINI_AGENT_TOS_REGION`. If an endpoint is provided, both native
`tos-<region>.volces.com` and S3 `tos-s3-<region>.volces.com` hosts are
accepted; uploads use the S3 host internally. A leading `https://` is optional.
For VPC access, set the internal S3 host (`tos-s3-<region>.ivolces.com`).
`MINI_AGENT_TOS_SIGNED_URL_EXPIRES` defaults to `3600` seconds.

## Verify

Run:

```bash
npm run dev -- doctor
```

Then use local media only for the cases that need TOS:

- large local video/image files that exceed inline limits
- local audio files that need standard ASR or another model-reachable URL

For small local video/image files, mini-agent can still send inline Base64
without TOS. For existing reachable media URLs, pass the URL directly.
