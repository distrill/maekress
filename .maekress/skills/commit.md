# Commit

Commit the repository's current changes directly on `main`.

1. Run `git status --short --branch` and inspect the staged and unstaged diff.
2. If the current branch is not `main`, switch to `main`. If switching would overwrite or conflict with local work, stop and explain the problem rather than discarding anything.
3. Run the relevant tests or validation command when practical.
4. Stage all repository changes with `git add -A`.
5. Create a single commit on `main` using a concise commit message that accurately summarizes the changes. Do not amend, force-push, or push unless explicitly requested.
6. Report the commit hash and final `git status --short --branch`.
