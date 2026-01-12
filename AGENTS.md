# Agent Guidelines

## General Principles
- **Strictness**: ALWAYS/NEVER = strict rules. Prefer/Avoid = strong defaults with exceptions allowed
- **Git Operations**: NEVER EVER do ANY git operation (`git add`, `git stage`, `git restore --staged`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`, `git rebase`, etc.) without EXPLICIT user permission. This is an absolute rule with ZERO exceptions. Only the user initiates git operations
- **Verify Before Implementing**: ALWAYS verify APIs, library features, and configurations before implementation. NEVER assume attributes, methods, or behavior exist without verification. Use context7 for library/framework docs. Use Exa for discovery (broad searches, ecosystem, community resources, tutorials). Use WebFetch for deep-diving into specific URLs
- **Documentation**: Use `docs/README.md` as the main documentation file (rest of `docs/` folder available for additional docs)
- **Ask Questions**: ALWAYS ask if unclear. NEVER assume. STOP and ask before proceeding if ANY of:
  - Multiple valid approaches exist
  - User intent could be interpreted multiple ways
  - Requirements are vague or incomplete
  - Design decisions needed (architecture, patterns, data models, APIs)
  - Trade-offs exist between options
  - Scope is ambiguous (what's in/out, how deep to go)
- **Question Tool** (`mcp_question`, referred to as `question_tool`): PREFER over plain text when there are predefined options (including y/n)

## Feature Workflow
1. **Research**: Understand the codebase, requirements, and constraints before making changes
   - Check existing patterns and implementations for similar functionality
   - Review related tests to understand expected behavior
   - Identify dependencies and potential side effects
2. **Plan**: Create an initial plan breaking down the task into clear, actionable steps
   - Create a markdown feature file in `docs/features/` named `YYYY-MM-DD-HHMM_FEATURE_NAME.md`
   - Use `date +%Y-%m-%d-%H%M` to get the timestamp (e.g., `docs/features/2025-11-26-1530_AUTHENTICATION.md`)
3. **Present Summary**: Present a brief plan summary to the user
   - Use `question_tool`: "Go to clarifying"
   - If user adds context/feedback: immediately update the feature file
   - Continue showing the prompt until user confirms
   - Only proceed to step 4 (Clarify) after user confirmation
4. **Clarify**: Ask questions to ensure complete understanding. REQUIRED before implementation if ANY ambiguity exists
   - Ask ONE question at a time, wait for answer, then ask the next question
   - Use previous answers to inform subsequent questions
   - Use `question_tool` when options can be predefined; plain text otherwise
   - Update the feature file with each Q&A after answering
   - Continue until ALL ambiguities resolved - don't stop after pre-written questions. Proactively identify new ambiguities and ask follow-ups. Don't ask permission to continue
   - Know when to stop: architecture, file structure, user-facing changes, breaking changes, major patterns - NOT minor implementation details
   - After all questions: comprehensively update plan with all decisions
   - NEVER skip if uncertain - defaulting to assumption is unacceptable
5. **Confirm**: Present the final plan summary. Use `question_tool`: "Implement this plan"
   - If user confirms: proceed to implementation
   - If other feedback: adjust the plan and ask for confirmation again
6. **Implement**: Execute the plan incrementally, following code style and architecture guidelines
   - Write tests alongside implementation
   - Make incremental commits for major milestones if working on large features
7. **Validate**: Run all quality gates in order to ensure correctness (see Quality Gates section)
   - If any gate fails: fix issues and re-run all gates from the beginning
8. **Update Feature File**: Sync the feature file with any discussions, decisions, or changes not yet documented
9. **Complete**: After all quality gates pass, summarize changes made and ask about committing (see Version Control section)

## Architecture
NixOS system configuration using Nix flakes with home-manager for user configuration:
- **Flake Inputs**: nixpkgs-unstable, home-manager, nix-flatpak, stylix (theming)
- **Module System**: Each module in `modules/` exports both `nixos` and `home` attributes for system and user configuration respectively
- **Auto-import**: Modules are automatically imported from the `modules/` directory via `configuration.nix`
- **Hardware**: NVIDIA drivers, systemd-boot, EFI system
- **Desktop**: GNOME with extensive dconf configuration and custom extensions

## Project Structure
Key directories:
- `modules/` - NixOS and home-manager modules, each exporting `{ nixos = {...}; home = {...}; }` structure
- `modules/opencode/` - OpenCode AI assistant configuration and secrets
- `modules/speechtotext/` - Custom GNOME extension for speech-to-text
- `modules/stylix/` - Theming configuration with stylix
- `modules/zsh/` - Shell configuration including fastfetch
- `modules/rclone/` - Cloud storage sync configuration
- `.opencode/` - OpenCode plugins, commands, and skills

Key files:
- `flake.nix` - Nix flake definition with inputs (nixpkgs, home-manager, nix-flatpak, stylix)
- `configuration.nix` - Main configuration that imports all modules and sets up home-manager
- `hardware-configuration.nix` - Hardware-specific configuration (auto-generated)

## Code Style

### General Principles
- **Simplicity**: Straightforward solutions. No unnecessary intermediate variables—directly invoke/access if used once
- **Paradigm**: Functional only—pure functions, immutability (Nix is inherently functional)
- **Duplicate Code**: Extract to reusable modules or let bindings
- **Dependencies**: Check existing flake inputs before adding new ones. Document rationale for major additions

### Style & Formatting
- **Formatting**: Alejandra formatter (standard Nix formatter), empty line at end of files, whitespace between logical blocks
- **Property Ordering**: Alphabetical by default unless another ordering makes better sense

### Nix Practices
- **Module Pattern**: Always export `{ nixos = {...}; home = {...}; }` from modules
- **Attribute Sets**: Use `with pkgs;` sparingly, prefer explicit references for clarity
- **Let Bindings**: Use for reusable values within a scope
- **Imports**: Use relative paths from module location
- **Conditionals**: Use `lib.mkIf` and `lib.mkForce` for conditional configuration
- **Lists**: Use `++` for list concatenation, `map` for transformations
- **Options**: Prefer home-manager options over direct file management when available

### Naming Conventions
- **Files**: Lowercase with hyphens (e.g., `hardware-configuration.nix`)
- **Modules**: Named after their primary function (e.g., `gnome.nix`, `firefox.nix`)
- **Folders**: Only use when module needs additional files (e.g., `stylix/default.nix` with `wallpaper.jpg`)

### Comments & Documentation
- **When**: Explain "why" not "what"—business logic, workarounds, non-obvious decisions
- **Avoid**: NEVER restate code. If self-explanatory, no comment needed
- **TODOs**: `# TODO:` with context

### Config & Environment
- **Secrets**: Use `secrets.json` files within module directories, never commit actual secrets
- **Hardware**: Keep hardware-specific config in `hardware-configuration.nix`

## Quality Gates
Run in this order to fail fast:

1. Nix flake check must pass (`nix flake check`)

## Version Control

### CRITICAL: Explicit Permission Required
- **NEVER do ANY git operation without explicit user permission** - This includes: commit, push, stage, unstage, branch operations, merges, rebases, etc.
- **ALWAYS use `question_tool` and wait for user confirmation** before executing ANY git command
- **Even if quality gates pass, even if the user said "commit" earlier in the conversation, even if it seems obvious** - STOP and ask for confirmation with the exact options below
- **No exceptions. No shortcuts. No assuming intent.**

### Quality Gates & Timing
- **Quality Gates Required**: Run ALL quality gates before ANY git operation. If any gate fails, inform the user and stop
- **When to Ask About Committing**: Ask when you feel like it makes sense
  - Logical unit complete (feature/bugfix/refactor/task finished)
  - Quality gates pass (or minimally, changes validated)
  - Before significantly different task
  - **Key principle**: When in doubt, ask. Only skip if certain larger commit coming
- **Commit Workflow**: NEVER commit automatically. Only ask when logical
  - Use `question_tool`: "Start committing"
  - If user confirms: Run quality gates first. If any gate fails, inform the user and stop. Then proceed with commit workflow:
    - Check staged files (`git status`, `git diff --staged`)
    - Display: files to unstage (if any), additional files to stage (if any), proposed commit message (conventional format describing ALL changes), horizontal rule (`---`)
    - Use `question_tool` with options based on staging needs:
      - If staging changes needed (files to unstage or additional files to stage): "Stage" | "Stage and commit" | "Stage, commit and push"
      - If no staging changes needed: "Commit" | "Commit and push"
    - On "Stage": unstage specified files, stage additional files, show staged changes, prompt with commit options
    - On commit/push options: perform staging changes if needed, then commit (and push if selected)
    - On other response: treat as instruction (modify message, change files, make more changes, etc.)
    - If file changes made relevant to current commit: restart entire workflow from beginning
  - On other response: treat as instruction (don't start commit workflow)
- **Commit Message Format**: `emoji type(scope): description`
  - Examples: `✨ feat(gnome): add blur-my-shell extension` | `🐛 fix(drivers): resolve nvidia sleep issue` | `♻️ refactor(modules): extract common patterns`
  - **Body**: Keep simple and concise. Skip body for obvious changes. Use bullet list only for meaningful details (key architectural decisions, breaking changes, important context). Avoid exhaustive change lists
- **Types with Emojis**:
  - `✨ feat` - New feature
  - `🐛 fix` - Bug fix
  - `♻️ refactor` - Code refactoring
  - `✅ test` - Adding or updating tests
  - `📚 docs` - Documentation changes
  - `🔧 chore` - Maintenance tasks
  - `⚡ perf` - Performance improvements
  - `🎨 style` - Code style/formatting changes
  - `🔒 security` - Security improvements
- **Scope**: Module name (e.g., `gnome`, `firefox`, `stylix`, `system`, `drivers`)

## Commands
- **Format**: `alejandra .` (format all Nix files)
- **Check**: `nix flake check` (validate flake)
- **Build**: `sudo nixos-rebuild build --flake .` (build without switching)
- **Switch**: `sudo nixos-rebuild switch --flake .` (build and switch to new configuration)
- **Update**: `nix flake update` (update flake inputs)
- **Garbage collect**: `sudo nix-collect-garbage -d` (remove old generations)
