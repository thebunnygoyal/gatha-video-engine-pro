# Gatha video engine

This service turns scenes into an H.264 video using the existing ElevenLabs,
FAL FLUX, FAL MiniMax and Remotion pipeline. Output stays in the configured GCS
bucket at `renders/<job_id>.mp4`.

## Invocation and response contract

**Cloud Run IAM must restrict invocation to authorized identities.** The service
must not grant `roles/run.invoker` to `allUsers`, and the platform's invoker check
must remain enabled. Authentication applies to both `/generate` and `/health`.
The local Express router does not treat user-provided identity headers as proof
of authentication. Restrict direct container access outside Cloud Run as well.

An authorized caller sends a Google identity token whose audience is the service
URL, then posts JSON to `/generate`:

```json
{
  "scenes": [
    {"text": "Narration", "prompt": "A landscape", "camera_move": "pan left"}
  ]
}
```

The request now stays open until generation and upload complete. The previous
immediate `processing` acknowledgement has been replaced with this final result:

```json
{
  "job_id": "<uuid>",
  "status": "completed",
  "result": {
    "bucket": "<configured-bucket>",
    "object": "renders/<uuid>.mp4",
    "gcs_uri": "gs://<configured-bucket>/renders/<uuid>.mp4"
  }
}
```

Caller/proxy timeouts must accommodate the request. There is no status-polling
route or durable queue. A disconnected/timed-out request or instance termination
can leave a paid provider outcome or upload uncertain; **do not automatically
repeat an accepted generation**. Errors include a sanitized code and job ID when
one was accepted. A cleanup failure after upload includes the known result and
blocks further admission until shutdown/recovery; it does not delete the GCS file.

`GET /health` returns `OK` while the request owner is available, or HTTP 503 during
shutdown/blocked cleanup. It does not prove external credentials or generation.

## Bounds and ownership

- JSON body: 100 KiB after parsing/decompression.
- Scenes: 1-12. Text and prompt: 1-4,000 Unicode code points each. Optional camera
  movement: at most 256 code points. Invalid input is rejected before provider work.
- One admitted job per instance. Additional requests receive HTTP 503 `busy` and
  `Retry-After: 10`; they have not started provider work.
- Total deadline: 3,300 seconds. Stage limits: startup 30, bundle 180, speech 90,
  FLUX 180, MiniMax 600, render 900, upload 120 and finalization 10 seconds.
- Speech responses are capped at 20 MiB, provider JSON at 1 MiB, and completed
  rendered output at 512 MiB. Axios follows no redirects and performs no paid
  retry. GCS uploads are non-resumable with automatic retry disabled.
- Each request owns a Linux worker and its native descendants. Cancellation uses
  Remotion's cancel signal and an explicitly owned browser. A separate parent
  ledger checks PID/start time, ancestry and an inherited random job marker in
  `/proc`, including Chromium's separate group and reparented processes. It does
  not retain or log process environment contents. After a one-second cooperative
  grace, remaining owned processes are frozen/killed. Leader close and two empty
  scans for executing owned processes are required before cleanup/admission.
- Cancellation settlement has a six-second bound in addition to the work
  deadline. If inspection or cessation cannot be confirmed, the instance rejects
  more work and retains its owned files for instance recovery. A zombie is no
  longer executing or holding files; reaping belongs to its parent/container init.
  Overall timeout, stage timeout, response disconnect and shutdown share this
  owner. Linux process metadata/environment access is required; failure is closed.
- A completed immutable Remotion bundle is reused by later jobs in the same
  instance. Failed or missing bundles are discarded and can be rebuilt.
- Every job gets an allocated temporary directory. Audio is served only over an
  ephemeral loopback listener with an unguessable capability and exact file
  allowlist, including HEAD/range support. No `file://` browser access or arbitrary
  local path route is used. The listener expires before job cleanup.

The composition remains 1920x1080 at 30 fps, with 150-frame scenes and 15-frame
slide transitions. The existing fixed scene duration is unchanged; this repair
does not add speech-duration analysis. Provider voice, models and settings are
unchanged. Existing `FAL_API_KEY`, `ELEVENLABS_API_KEY`, `GCS_BUCKET_NAME`, Chromium
path settings and Cloud Run service identity are supplied by the deployment;
secret values must not be committed, printed or replaced by build arguments.

## Reproducible runtime and explicit build inputs

The Dockerfile extends the existing deployed image by immutable digest:

```text
gcr.io/windy-lyceum-460319-c7/gatha-video-engine-pro@sha256:e8cc2dcfa45ae2a37ffb04563fe080af9a9a5b86c91305173ef07803e3d7bc89
```

It replaces only `server.js`, `lib/` and `src/`. It runs no npm or apt install and
retains the installed dependency graph, Node, Chromium and ffmpeg. Current runtime
metadata is Remotion 4.0.526, Express 4.22.3, Axios 1.20.0 and Google Cloud Storage
7.22.0. `package.json` describes the historical install; its caret ranges are not
resolved by this repair's build. New images carry the full source revision label.

The default `production` target excludes verification fixtures. The separate
`verification` target includes `tests/` and `verify/`. `.dockerignore` admits only
these explicitly named application/build inputs. Neither target copies local
credentials, evidence, repository metadata or a developer's node_modules.

## Non-billable verification

Run pure source checks with Node's built-in test runner:

```sh
node --test tests/policy.test.js tests/media.test.js tests/generation.test.js tests/owner.test.js tests/runtime.test.js tests/process-ledger.test.js
```

The authoritative HTTP/Linux/native checks run inside the pinned image. From a
clean checkout, using the exact reviewed full Git commit:

```sh
revision=$(git rev-parse HEAD)
docker build --target verification --build-arg SOURCE_REVISION="$revision" -t "gatha-video-verify:$revision" .
docker run --rm --network none --cpus 4 --memory 8g "gatha-video-verify:$revision"
docker build --target production --build-arg SOURCE_REVISION="$revision" -t "gatha-video-candidate:$revision" .
```

`verify/run.js` checks the installed versions, runs source/HTTP/process lifecycle
regressions, then renders one synthetic local video with real Chromium/Remotion/
ffmpeg and loopback MP3 audio. It checks dimensions, frame count, duration and a
non-silent audio track. It also cancels a real render while Chromium and ffmpeg
are executing, then forces shutdown of an uncooperative worker with a separate
Chromium group and a deliberately reparented native ffmpeg. It checks cessation
before directory deletion and preserves an unrelated native process. Provider
methods and GCS upload are replaced in this fixture; the container has no external
network and no secrets need be passed.
Fixture code is not part of the production image or a runtime API bypass.

A passing offline fixture proves the local media path and covered error handling.
It does not prove valid paid provider credentials, a real generated video, durable
recovery or a cost/throughput improvement. Keep these distinctions in release
receipts. A production release also requires the owner's fresh IAM check,
unauthenticated rejection, authenticated health/invalid-input readback, immutable
image/revision identity and the prior digest retained for rollback.
