# YouTube Live Batch Creator

A standalone Tampermonkey userscript for batch-creating YouTube Studio live events.

## Install

1. Ensure Tampermonkey is installed in your browser.
2. Click [here](https://github.com/louis6321/yt-live-batch-creator/raw/refs/heads/main/yt-live-batch.user.js).

## Use

1. Sign in to the correct YouTube channel.
2. Open YouTube Studio Live Control Room or the Studio Live page.
3. Click `Batch Create` next to YouTube's `Schedule Stream` button.
4. In the `Live Batch Creator` panel, paste one stream title per line in the `Titles` box.
5. Paste one exact visible stream key label per line in the `Stream keys` box. Both boxes are numbered, and matching numbers pair up: title 3 uses stream key 3. The line count beside each label turns amber when the two boxes do not have the same number of lines.
6. Choose visibility, latency and auto-start, and optionally adjust the auto-filled start time.
7. Click `Start`.

The panel is a compact overlay in a bottom corner. Use `-` in its header to minimise it to a single status strip, `+` to expand it again, and `Close` to hide it entirely. While a batch runs it minimises itself and moves to the bottom-left corner so it stays clear of the Studio dialog's `Next` and `Done` buttons, and it expands again when the run finishes. The minimised strip still shows live status and a `Stop` button.

Visibility defaults to `Unlisted`. Start time auto-fills to the current local time. The script always sets made-for-kids to `No`, mirrors the stream title into Rights Management `Asset title`, disables visible live chat controls, creates the event, then selects that event's paired stream key after creation.

Latency defaults to `Normal`, which is also YouTube's own default — selecting it means the script skips the latency step entirely. Choosing `Low` or `Ultra-low` sets `Stream latency` on the stream settings page immediately after the stream key is confirmed, then waits 3 seconds for Studio to save before moving on. If the latency setting is already on the requested value, the script leaves it alone and skips the wait.

`Enable auto-start` is off by default and runs immediately after the latency step, so it always follows that 3-second settle. When it is off the script does not touch the `Auto-start` toggle at all, leaving it at whatever Studio defaults to. When it is on the script switches `Auto-start` on and accepts the `Enable Auto-start` prompt that Studio raises, then confirms the toggle really is on. It stops the batch if it cannot.

If the script cannot attach next to `Schedule Stream`, it falls back to a fixed `Batch Create` button near the top-right of the page. If no button appears, click the Tampermonkey extension icon while you are on `studio.youtube.com`, confirm `YouTube Live Batch Creator` is enabled, then use the Tampermonkey command `Show Live Batch Creator` and reload the page if needed.

## First Test

Run the first test with two harmless titles, two matching stream-key lines, and `Private` visibility. After the batch completes, verify each event in YouTube Studio:

- Title matches the input line.
- Rights Management `Asset title` matches the title.
- Made-for-kids is set to `No`.
- Live chat features are disabled.
- Visibility and start time are correct.
- The matching per-line stream key is selected after creation.
- `Stream latency` matches the selected setting (only when you chose `Low` or `Ultra-low`).
- `Auto-start` is on (only when you ticked `Enable auto-start`).

If the script cannot find the stream key after creating an event, it stops the batch and logs the event URL so you can recover manually.

## Notes

YouTube Studio changes its DOM often. This script anchors on visible English labels like `Asset title`, `Live chat`, `Visibility`, and `Stream key`, and it searches open shadow DOM roots where Studio places many controls.
