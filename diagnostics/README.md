# Firestore client diagnostics

Capture is opt-in and local. No diagnostic events are sent to Firestore or another server. Do not enable raw SDK debug logs or save HAR files, which can include documents and credentials.

For application subscriptions, open the app's developer console and run `window.bookTrackerDiagnostics.start()`. Then navigate through the pages involved, without reloading the tab. Capture expires after ten minutes and retains at most 500 events in memory. Run `window.bookTrackerDiagnostics.download()` to save the current ring to a local JSON file. Use `.stop()` to stop recording, or `.clear()` to stop and erase it. Reloading erases the capture. Starting capture does not restart any existing subscription, so existing listeners first appear when their next snapshot arrives or they stop.

Exports contain static query labels, start/stop events, snapshot sizes and cache/write metadata, allowlisted error codes, visibility and online state, a random capture and tab ID, origin category, and the emitted module filename identifying the build. They exclude query paths, user identifiers, documents, credentials and raw errors. Metadata is recorded on snapshots normally delivered to the application; the diagnostic does not request extra metadata-only callbacks. Snapshot sizes are not billed reads.

For a separate short wire diagnostic, use an already running, explicitly debugging-enabled Chromium browser with one matching application tab. This command attaches through a localhost CDP endpoint, observes 60 seconds, and disconnects without navigating or reloading:

```
node diagnostics/captureListen.ts http://127.0.0.1:9222 https://book.ankile.com /tmp/book-listen-summary.json
```

The output file must not already exist. It is created with owner-only permissions. Only numeric summaries are saved: target additions, targets with resume state, RESET events, existence filters, document changes/deletes/removes, and malformed/oversized payload counts. Payloads are processed transiently in memory and never written or printed. It uses CDP streaming to summarize complete WebChannel frames while Listen responses remain open. UTF-8 chunks and the initial buffered prefix are combined transiently, then discarded after each summary. Storage is capped at 2 MB per stream and 4 MB across streams, with at most 32 streams and pending streaming commands. Requests that predate capture, have partial frames at expiry, exceed these limits, or cannot enable streaming are incomplete evidence, not zero transfers. The export reports incomplete requests/streams, dropped streams and streaming failures. An unavailable streaming API produces an explicit incomplete-capture warning. In particular, an empty capture cannot establish successful resumptions. No browser request headers, raw URLs, document IDs or resume tokens appear in the output.

Match export timestamps with Monitoring's minute-level query reads/listener counts. A target with resume state followed by RESET is a different hypothesis from repeated starts without resume state. Aggregate counters cannot pair a reset with a particular target, and transferred document counts alone do not establish billing. Review summaries before sharing them; keep captures out of version control.

Streaming API reference: [Chrome DevTools Protocol Network.streamResourceContent](https://chromedevtools.github.io/devtools-protocol/tot/Network/#method-streamResourceContent).
