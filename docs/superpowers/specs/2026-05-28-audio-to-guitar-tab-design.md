# Audio to Guitar Tab Design

Date: 2026-05-28

## Goal

Build an upload-first application that accepts short music clips and produces:

- detected musical key,
- tempo and beat-grid metadata,
- standard-tuning guitar tablature with string and fret positions,
- confidence information that makes uncertain sections visible,
- exportable text tab, MIDI, and a JSON debug bundle.

The first version targets clean guitar clips and guitar-forward clips with drums or backing tracks. It assumes standard six-string guitar tuning, E A D G B E, and one primary guitar part.

## Non-Goals For V1

- Live microphone transcription.
- Multiple simultaneous guitar-part separation.
- Guaranteed exact fingering from dense full-song mixes.
- Editable in-browser correction workflow.
- Guitar Pro, MusicXML, or other rich notation export.
- Training a custom guitar transcription model.

## User Workflow

1. The user uploads an MP3, WAV, or M4A clip.
2. The app creates a transcription job and shows progress.
3. The backend analyzes the clip, optionally separates likely stems, transcribes the guitar-like audio, and maps notes to guitar tab.
4. The result page shows key, tempo, tab, timing alignment, and confidence by bar or phrase.
5. The user can export plain text tab, MIDI, and a JSON debug bundle.

## Architecture

The app is split into four bounded components.

### Upload And Job API

The upload API accepts audio files, validates type and size, stores the original asset, creates a job record, and returns a job ID immediately. The UI uses that job ID to poll or subscribe to progress updates.

### Audio Analysis Worker

The worker normalizes the uploaded clip into a processing-friendly audio format, detects key, tempo, and beat grid, and decides whether source separation is needed. Clean guitar clips can skip source separation. Guitar-forward clips with drums or backing should run separation before transcription.

### Transcription And Tab Engine

The transcription engine converts guitar-like audio into structured notes. A practical first implementation can use an audio-to-MIDI model such as Basic Pitch, with source separation such as Demucs before transcription when the uploaded clip includes drums or backing. The tab engine then maps each note to a standard-tuning string and fret.

String/fret assignment is an inference. The engine should prefer playable positions by using fret-distance rules, continuity across phrases, common guitar positions, and a configurable fret range. The system should keep both the note-level transcription and the derived tab so errors can be diagnosed at the right layer.

### Review UI

The UI shows the uploaded clip, playback controls, detected key, detected tempo, generated tab, and confidence markers. V1 can be read-only. Editing, correction, and re-fingering controls should be later milestones once baseline transcription quality is visible.

## Data Flow

Each job writes stage artifacts so failures and quality issues are diagnosable:

- original uploaded audio,
- normalized working audio,
- optional separated stems,
- analysis JSON with key, tempo, beat grid, and optional section markers,
- transcription JSON with note onset, duration, pitch, velocity, and confidence,
- tab JSON with string, fret, timing, bar, and confidence,
- rendered plain-text tab for display and export.

The job should be asynchronous. Upload returns quickly, processing runs in a worker, and the UI displays progress for each stage.

## Error Handling

The app should treat uncertain transcription as expected behavior. V1 should explicitly represent:

- unsupported file type,
- file too large or clip too long,
- audio normalization failure,
- no clear pitched instrument detected,
- low-confidence key,
- low-confidence transcription,
- source-separation artifacts or bleed,
- ambiguous string/fret fingering,
- partial success when analysis or transcription succeeds but tab generation has low confidence.

When a later stage fails, the app should preserve earlier artifacts and show the most useful partial result available.

## Quality Controls

V1 should enforce a maximum clip length, likely 30 to 90 seconds while the pipeline is being tuned. The exact default can be adjusted after timing the first worker implementation.

The app should expose two processing modes:

- clean clip: skip source separation and transcribe directly,
- mixed clip: run source separation before transcription.

An automatic mode can choose between them later, but explicit modes are useful during early quality tuning.

## Testing Plan

The fixture set should include:

- clean single-note guitar,
- clean riff,
- guitar plus drums,
- guitar plus backing track,
- dense full mix,
- non-guitar audio as a negative test.

Automated tests should verify file validation, job state transitions, artifact persistence, tab JSON shape, export generation, and deterministic behavior of the fingering engine for known note sequences.

Manual quality review should compare generated tab against known references for the fixture clips and record confidence, common failure modes, and whether source separation improved or degraded the result.

## Open Implementation Decisions

- Initial web stack and storage target.
- Local-only processing versus server-hosted worker.
- Exact clip length and file-size limits.
- Which source-separation model to use for the first prototype.
- Whether the first UI should include waveform and beat-grid alignment or only tab text plus audio playback.
