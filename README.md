# SampleSort

SampleSort is a desktop app (Electron) that organizes audio sample libraries into clean, searchable folders. It can:

- Sort files into **categories** based on keywords
- **Keep sample packs together** (e.g., `Pack (Collection)` style)
- Create subfolders by **length** (e.g., `Piano - Over 10 seconds`)
- **Analyze BPM** (renderer-side WebAudio via `bpm-detective`) and create `NNN BPM` folders
- Create subfolders by **Key** detected from file/folder names (e.g., `Bb Maj`, `F Min`)
- **Deduplicate** by file hash (skip or quarantine to `_Duplicates`)
- **Dry run** mode (preview everything without touching files)
- **BPM/Key-only** post-process on an already organized Destination

> MIDI files (`.mid`, `.midi`) are included for sorting & dedupe but **skipped** for BPM analysis.

## App Preview

<video
  src="SampleSort/blob/main/src/images/SampleSort%20Preview.mp4"
  width="900"
  autoplay
  controls
  muted
  loop
  playsinline
  poster="SampleSort/blob/main/src/images/SampleSort%20Screenshot.png">
  Your browser doesn’t support the video tag.
</video>

---

## Requirements

- Node.js 18+ (recommended)
- npm (or yarn/pnpm)
- Windows/macOS/Linux

---

## Install & Run

```bash
# Install dependencies
npm install

# Run in your IDE
npm start

## Usage

- **Sample Directory**: the source folder that contains your packs/samples.  
- **Destination Directory**: where organized files will go (new folder recommended).
- **Folders & Categories**: add folders and category/keyword pairs.
- **File Extensions**: make sure your desired audio formats are listed (e.g., `wav`, `aiff`, `mp3`, `flac`).

### Options (right panel)

- **Move vs Copy**
- **Keep archives** after extraction
- **Match parent folder** when filename doesn’t match
- **Dedupe** (skip or quarantine)
- **Keep sample packs together**
- **Over-length subfolders** (threshold in seconds)
- **BPM analysis** (threshold in seconds, optional debug log)
- **Key folders** from names (optionally also parent folder)
- **MIDI sorting** to a dedicated `MIDI` folder
- **Dry run**: preview everything with no file changes

**Press _Start_.** Use **Stop Sort** to cancel gracefully.  
Use **Export Log** or **Clear Log** as needed.

---

## Post-process BPM/Key (Destination-only)

If your library is already organized and you just want BPM/Key:

1. Enable **“Run BPM and/or Key sort on an organized Destination Directory.”**
2. Click **“Run BPM/Key sort.”**

This pass targets the **Destination** directory. You can optionally include files already inside `NNN BPM` folders.

## Notable IPC Channels

> **Direction legend:** `renderer → main` means the renderer sends/requests and main receives/handles.  
> `main → renderer` means the main process emits messages to the renderer.

| Channel | Direction | Kind | Purpose | Request Payload | Response |
|---|---|---|---|---|---|
| `start-organizing` | renderer → main | `send` | Start a sort run. | `runConfig` object (samples/dest dirs, options). | — |
| `organizing-log` | main → renderer | `send` | Stream log messages to UI. | `(message: string, type?: "info" \| "warning" \| "error" \| "success")` | — |
| `organizing-done` | main → renderer | `send` | Signal end of core organize pass. | `{ destDir: string, dryRun: boolean, newFiles: Array<{src:string, dest:string}> }` | — |
| `organizing-cancel` | renderer → main | `invoke/handle` | Request graceful cancellation. | — | — |
| `prepare-bpm-files` | renderer → main | `invoke/handle` | Build BPM worklist (filters, thresholds, skip rules). | `{ destDir: string, config: object, limitTo?: string[] }` | `Array<{ file: string, skipDetection: boolean, bpmValue?: number }>` |
| `bpm-results` | renderer → main | `invoke/handle` | Apply BPM-based moves after detection in renderer. | `{ items: Array<{file:string,bpmValue:number,keyValue?:string}>, sortByKey?: boolean, dryRun?: boolean }` | `number` (files processed) |
| `apply-key-folders` | renderer → main | `invoke/handle` | Create/move into Key subfolders across a tree. | `{ rootDir: string, extensions: string[], dryRun?: boolean, debug?: boolean, keyFromParent?: boolean, keyNoteOnlyFallback?: boolean, limitTo?: string[] }` | `number` (files updated) |

### Notes
- `prepare-bpm-files` respects `limitTo` (when present) to only consider newly moved/targeted files; otherwise it scans `destDir`.
- `organizing-done.newFiles` lists files moved/copied during the just-finished pass and can be fed into `limitTo` for post-processing stages (BPM/Key).

## Notes & Limitations

- **BPM analysis runs in the renderer** using WebAudio and `bpm-detective`. Very large files or files the browser can’t decode will be skipped.
- **Already-BPM’d folders are skipped by default**: files inside `NNN BPM/...` are not reprocessed during normal runs (to avoid churn). The post-process path can include them (see below).
- **MIDI files are excluded from BPM analysis** by design and are never audio-decoded.
- If you see **“Array buffer allocation failed”**, a file is too large for WebAudio. Consider transcoding to a smaller/shorter file or (carefully) raising internal limits.
- **DevTools `Autofill.enable` warnings are harmless** (Chrome protocol noise).

---

## Troubleshooting

### “No files found for BPM analysis.”
- Ensure **Extensions** include your actual formats (e.g., `wav`, `aiff`, `mp3`, `flac`).
- Temporarily **lower or disable `BPMThreshold`** to confirm detection works.
- For post-process runs, enable the option to **include files already under `NNN BPM` folders**  
  (the post-process code can pass `includeInsideBpmFolders: true` to the `prepare-bpm-files` IPC).

### Key sort does nothing
- Verify **`sortByKey`** is checked.
- Ensure filenames (or parent folders) contain recognizable **key tokens** (e.g., `A#`, `Bb`, `Min`, `Maj`).

---

## Acknowledgments

- [`bpm-detective`](https://www.npmjs.com/package/bpm-detective)
- [`music-metadata`](https://www.npmjs.com/package/music-metadata)
- **Electron** & the Web Audio ecosystem
