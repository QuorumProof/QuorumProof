# Video Tutorials

> Issue #1634. Index of QuorumProof video tutorials for common tasks, with the
> script, captions, and recording status for each. Text-only docs remain the
> reference; the videos are a guided on-ramp.

---

## Tutorial index

| # | Tutorial | Audience | Length | Script | Captions | Video |
|---|---|---|---|---|---|---|
| 1 | Getting started: build, deploy to testnet, run the API | Contributors, integrators | ~8 min | [script](./tutorials/scripts/01-getting-started.md) | [en.vtt](./tutorials/captions/01-getting-started.en.vtt) | Recording pending |
| 2 | Creating a quorum slice | Credential holders, integrators | ~6 min | [script](./tutorials/scripts/02-create-quorum-slice.md) | [en.vtt](./tutorials/captions/02-create-quorum-slice.en.vtt) | Recording pending |
| 3 | Issuing and attesting a credential | Issuers, attestors | ~7 min | [script](./tutorials/scripts/03-issue-and-attest.md) | [en.vtt](./tutorials/captions/03-issue-and-attest.en.vtt) | Recording pending |
| 4 | Verifying credentials through the REST API | Verifiers (employers, firms) | ~6 min | [script](./tutorials/scripts/04-verify-credentials.md) | [en.vtt](./tutorials/captions/04-verify-credentials.en.vtt) | Recording pending |
| 5 | Sharing a credential and revoking access | Credential holders | ~5 min | [script](./tutorials/scripts/05-share-and-revoke.md) | [en.vtt](./tutorials/captions/05-share-and-revoke.en.vtt) | Recording pending |

When a video is published, replace "Recording pending" with a link to it and
fill in the exact runtime.

### Suggested learning paths

- **I want to contribute code:** 1 → 2 → 3, then [architecture.md](./architecture.md).
- **I want to verify engineers' credentials:** 4, then [api-response-examples.md](./api-response-examples.md).
- **I am an engineer building my credential profile:** 2 → 5, then [privacy-guide.md](./privacy-guide.md).
- **I run an issuing institution:** 3, then [issuer-security-checklist.md](./issuer-security-checklist.md).

---

## Directory layout

```
docs/
├── video-tutorials.md              ← this index
└── tutorials/
    ├── scripts/NN-<slug>.md        ← narration + on-screen actions, per scene
    └── captions/NN-<slug>.en.vtt   ← WebVTT captions (one file per language)
```

Additional caption languages use the same slug with a different BCP 47 tag,
e.g. `03-issue-and-attest.es.vtt`.

---

## Script format

Every script uses the same structure so recordings stay consistent:

1. **Header** — title, audience, prerequisites, target length, learning goals.
2. **Scenes** — numbered, each with a timecode budget, `On screen` (what the
   viewer sees / what the presenter types), and `Narration` (what is said).
3. **Recap** — three to five bullet takeaways.
4. **Links** — the text docs the video summarizes.

Keep commands in scripts copy-pasteable and identical to what is typed on
screen. Use testnet only and placeholder addresses; never show a real secret
key, even a testnet one.

---

## Recording guide

### Setup

- **Resolution:** 1920×1080 at 30 fps. Terminal and editor font ≥ 18 pt.
- **Terminal:** light or dark theme with high contrast; hide the prompt's
  hostname/username (`export PS1='$ '`).
- **Browser:** clean profile, no extensions visible, zoom 125 %.
- **Audio:** external microphone, quiet room, −16 LUFS integrated loudness.
- **Tools:** OBS Studio (free) or any screen recorder that outputs MP4/H.264.

### Before recording

1. Run through the script end to end on a fresh testnet identity.
2. Pre-fund accounts with Friendbot so there is no waiting on camera.
3. Export environment variables used in the script in a hidden shell.
4. Close notifications, chat apps, and anything showing personal data.

### While recording

- Follow the script scene by scene; small ad-libs are fine but keep commands
  exactly as written so captions stay in sync.
- Pause ~1 s after each command's output appears so viewers can read it.
- If a command fails, stop, fix, and re-record the scene rather than editing
  around it.

### After recording

1. Trim dead air; keep each scene within its timecode budget (±15 s).
2. Update the caption timestamps in the matching `.vtt` file to the final cut
   (see below).
3. Scrub the video for secrets, personal addresses, or tokens before upload.
4. Upload (unlisted first), get a second reviewer to watch it, then publish.
5. Update the index table above with the link and runtime.

---

## Captions

All videos **must** ship with captions. Captions are WebVTT files kept in the
repo so they can be reviewed and translated like any other doc.

- Caption text follows the script narration verbatim, split into cues of at
  most two lines and ~42 characters per line.
- Each cue shows for 1–7 seconds.
- Identify on-screen commands in captions only when they are spoken.
- Non-speech audio that matters is marked in brackets, e.g. `[typing]`.
- The timestamps committed with each script are **planning estimates** based
  on the script's timecode budget. Re-time them against the final edit before
  uploading (e.g. with Subtitle Edit or Aegisub), and commit the re-timed file.
- Upload the `.vtt` to the video host as the default English track; do not
  rely on auto-generated captions.

### Validating a caption file

A valid file starts with `WEBVTT`, has a blank line between cues, and each
cue timing line matches `HH:MM:SS.mmm --> HH:MM:SS.mmm`. Most players and
`ffmpeg -i video.mp4 -i captions.vtt …` will reject malformed files.

---

## Contributing a new tutorial

1. Pick the next number and a short slug.
2. Write `tutorials/scripts/NN-<slug>.md` using the script format above.
3. Write `tutorials/captions/NN-<slug>.en.vtt` from the narration.
4. Add a row to the [tutorial index](#tutorial-index) with "Recording pending".
5. Open a PR; once merged, record following the [recording guide](#recording-guide).
