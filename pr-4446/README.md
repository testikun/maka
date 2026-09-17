# PR #4446: real Electron verification

Feature head: `3b91afc51` (includes main `672d82731`).

These are direct screenshots of the built desktop app on macOS, using the
operator's local Codex Responses relay and `gpt-5.6-sol`. FakeBackend was not
enabled. Only synthetic release-planning conversations were used.

- `01-picker.png`: Session list aligned with the composer; both measure 800px.
- `02-staged.png`: one removable Session chip inside the input surface.
- `03-narrow-multiple.png`: two selected Sessions in an 860px-wide native window.
- `04-real-answer.png`: a real model response based on the selected Session.
- `05-error-preserves-draft.png`: archive-after-selection failure with localized
  feedback, preserving the draft and reference.

Verification includes selecting, removing and sending references, ordinary
sentences containing `@`, and the localized failure path. The original running
source/unfinished-stream case was also checked with the deterministic backend
and is covered by the main-process regression suite.
