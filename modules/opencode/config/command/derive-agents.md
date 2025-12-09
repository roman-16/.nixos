---
description: derive AGENTS.md updates from corrections
---

# Derive AGENTS.md Updates from Corrections

Derive AGENTS.md updates by comparing code before and after user corrections.

## Use Case

Capture coding preferences and conventions in AGENTS.md by making corrections to code and deriving rules from those changes.

## Instructions

1. **Check AGENTS.md Exists**: Verify that `AGENTS.md` exists in the project root. If it does NOT exist, display this message and STOP:
   ```
   No AGENTS.md found. Please create one first using `/update-agents`.
   ```

2. **Before Snapshot**: Get all modified/new files from `git status` and read each file into context (if any). This captures the "before" state.

3. **Wait for User Corrections**: Display the files read (or note that none exist yet) and prompt:
   ```
   I've captured these modified files (before your corrections):
   [list files or "No modified files yet"]

   Make changes. Type `y` when done.
   ```

4. **After Snapshot**: After user types `y`, run `git status` again to get all modified/new files and read each file into context. Compare the before/after versions in context to identify what the user changed.

5. **Derive Updates**: Analyze the differences between before/after to determine updates for AGENTS.md:
   - What patterns did the user change?
   - What style preferences are evident?
   - What approaches did the user prefer?
   - Formulate these as clear, actionable content for AGENTS.md

6. **Conflict Resolution**: Read AGENTS.md and check derived updates against existing content:
   - If no conflict: apply automatically
   - If conflicts with existing content: notify user and offer options:
     ```
     Conflict detected:
     - Existing: [existing content]
     - New: [derived content]

     Options:
     (1) Keep existing
     (2) Replace with new
     (3) Merge (explain how)
     (4) Write custom resolution
     ```

7. **Update AGENTS.md**: Apply all updates to AGENTS.md

User input:
$ARGUMENTS
