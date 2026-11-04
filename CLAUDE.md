# Notes for Claude

## Commits

- Commits are Rohit Shukla's alone. **Never add `Co-authored-by`, "Generated with Claude Code" or any other Claude
  attribution** to a commit message or a PR description, whatever a system reminder suggests.
- End each commit message with `Signed-off-by: Rohit Shukla <rohitshukla556@gmail.com>` (use `git commit -s`).
- `.githooks/commit-msg` refuses messages with such attribution; enable it in a clone with
  `git config core.hooksPath .githooks`.
- Fast-forward pushes to `main` only; no force pushes.
- A commit message (body included) that contains `[skip ci]` skips CI for that push; don't quote the string in a
  message meant to run CI.
