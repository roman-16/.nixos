# Agent Guidelines

## General Principles
- **Strictness**: ALWAYS/NEVER = strict rules. Prefer/Avoid = strong defaults with exceptions allowed
- **Dev Server Required**: The user will have [DETECT from project (`npm run dev`)] running during development. If it's not running and you need it, ask the user to start it. Use `question_tool`: "Continue". Once they confirm, continue with your work. [DETECT if Docker-based dev server - if so, use `docker logs <container>` for logs when needed]
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

## Code Style

### Testing [JS/TS]
- **Approach**: Write tests alongside implementation (TDD/test-first)
- **Test Strategy**: Write tests outside-in (e.g., e2e → integration → unit)
- **Location**: `.test.ts` files in `tests/` directory, mirroring `src/` structure
- **Framework**: vitest with exact matchers only (no relative matchers like `toBeCloseTo`, `toBeGreaterThan`)
- **Coverage**: Minimum 95% for statements, lines, and functions; 90% for branches
- **Mocking**:
  - **ONLY mock external dependencies** (npm packages) - NEVER mock our own code in `src/`
  - **Not all dependencies need mocking** - only mock dependencies that require it (external services, APIs, complex integrations)
  - **ALL mocks MUST be global** - place in `.vitest/mocks/` directory, named as `mock` + camelCased dependency name (e.g., `@google-cloud/secret-manager` → `mockGoogleCloudSecretManager.ts`)
  - **No local mocks** - NEVER use `vi.mock()` in test files. All mocking must be in `.vitest/mocks/`
  - **Mock setup**: Import mocks in `.vitest/setup.ts`, referenced by `vitest.config.ts`
  - **Mock exports**: Export mocks from `.vitest/mocks/index.ts` barrel file only when tests need to reconfigure them
- **Test Environment**: Set `process.env` in `.vitest/env.ts`, imported first in `.vitest/setup.ts`
- **Test Quality**:
  - Write meaningful tests validating behavior/edge cases
  - Avoid trivial tests (testing that functions exist, mocked implementations without behavior verification)
  - Test behavior, not implementation details
  - Use descriptive test names: `"should throw error when orderId is missing"`
  - Group related tests with `describe` blocks
- **DOM Selectors**: Define a `selectors` constant at the top of test files with all query selectors.
- **Validation**: Run `npm run test` after test changes

### Testing [Rust]
- **Approach**: Write tests alongside implementation
- **Test Strategy**: Write tests outside-in (e.g., e2e → integration → unit)
- **Location**: Co-located in same file using `#[cfg(test)]` module
- **Coverage**: Minimum 95% via cargo-tarpaulin
- **Test Types**:
  - Edge case tests (large inputs, boundary conditions)
  - Panic tests with `#[should_panic(expected = "...")]`
  - Main function execution tests
- **Test Quality**:
  - Test behavior, not implementation details
  - Use descriptive test names: `test_part1_example`, `test_part2_large_rotation`
  - Extract shared test data to constants: `const EXAMPLE: &str = "..."`

## Quality Gates [JS/TS]
Run in this order to fail fast:

1. TypeScript compilation must succeed with no errors (`npm run typecheck`)
2. Biome linting must pass (`npm run lint`)
3. All tests must pass and test coverage must meet minimum 95% threshold across all metrics (`npm run test`)
4. Project must build and run successfully (`npm run dev`)

## Quality Gates [Rust]
Run in this order to fail fast:

1. Code must compile with no errors (`just build`)
2. Lints must pass, clippy and check formatting (`just lint`)
3. All tests must pass and test coverage must meet minimum 95% threshold across all metrics (`just test`)
4. Project must build and run successfully (`just dev`)

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
      - If staging changes needed (files to unstage or additional files to stage): "Stage (s)" | "Stage and commit (c)" | "Stage, commit and push (p)"
      - If no staging changes needed: "Commit (c)" | "Commit and push (p)"
    - On `s`: unstage specified files, stage additional files, show staged changes, prompt with `c`/`p` options
    - On `c`/`p`: perform staging changes if needed, then commit (and push if `p`)
    - On other response: treat as instruction (modify message, change files, make more changes, etc.)
    - If file changes made relevant to current commit: restart entire workflow from beginning
  - On other response: treat as instruction (don't start commit workflow)
- **Commit Message Format**: `emoji type(scope): description`
  - Examples: `✨ feat(consumer): add retry logic` | `🐛 fix(zendesk): handle rate limiting` | `✅ test(consumer): add timeout scenarios`
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
- **Scope**: [DETECT from project structure]

## Commands [JS/TS]
- **Build**: `npm run build` (production) | `npm run dev` (development with watch)
- **Type check**: `npm run typecheck`
- **Lint**: `npm run lint`
- **Test**: `npm run test`
- **[Project-specific]**: [DETECT and document project-specific commands]

## Commands [Rust]
- **Build**: `just build` (release) | `just dev` (development)
- **Lint**: `just lint`
- **Test**: `just test`
- **[Project-specific]**: [DETECT and document project-specific commands]
