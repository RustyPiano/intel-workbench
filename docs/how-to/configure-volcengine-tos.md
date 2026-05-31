# Configure Volcano Engine TOS For Local Media

Use this only when local media must become reachable by a model service:

- large local video/image files that cannot be sent inline
- local audio for `analyze_audio`, which needs a URL

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
export MINI_AGENT_TOS_ENDPOINT=tos-cn-beijing.volces.com
```

`MINI_AGENT_TOS_ENDPOINT` defaults to
`tos-${MINI_AGENT_TOS_REGION}.volces.com` when region is set. Do not include
`https://`; mini-agent normalizes accidental `https://` input before calling
the TOS SDK.
`MINI_AGENT_TOS_SIGNED_URL_EXPIRES` defaults to `3600` seconds.

## Verify

Run:

```bash
npm run dev -- doctor
```

Then use local media only for the cases that need TOS:

- large local video/image files that exceed inline limits
- local audio files that need to be sent to Doubao ASR

For small local video/image files, mini-agent can still send inline Base64
without TOS. For existing reachable media URLs, pass the URL directly.
