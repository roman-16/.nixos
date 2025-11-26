---
description: create or update AGENTS.md to reflect the latest project structure and guidelines
agent: build
---

Update the `AGENTS.md` file to reflect the project. Look into the project for that.

Clear up the file to keep context small for the model, but don't lose any important information. Balance optimization with completeness:
- **What to compress**: Remove redundancy, verbose explanations of obvious concepts, excessive examples when one suffices
- **What to preserve**: All rules/requirements (even if rephrased shorter), specific examples that clarify non-obvious points, complete workflow steps, all commit types/emojis, all quality gates
- **Goal**: More concise without losing substance. If unclear whether to keep detail, err on the side of keeping it

Add content if needed. Keep the file clean and well-organized. You can update anything if needed.

**Section Flags**: Some subsections in the template below are marked with language/project type flags (e.g., `[JS/TS]`). These flags indicate which sections apply to specific project types:
- If the section applies to the current project: include the section content and REMOVE the flag from the output
- If the section does NOT apply: completely omit the entire section
- Never keep the flag markers `[JS/TS]` in the final AGENTS.md file

**Section Order**: Maintain the exact section order as shown below:
1. General Principles
2. Workflow
3. Architecture (project-specific)
4. Project Structure (project-specific)
5. Code Style
6. Quality Gates
7. Version Control
8. Commands

## Universal Sections (Keep Unchanged)

```markdown
## General Principles
- **Strictness**: ALWAYS/NEVER = strict rules. Prefer/Avoid = strong defaults with exceptions allowed
- **Git Operations**: NEVER EVER do ANY git operation (`git add`, `git stage`, `git restore --staged`, `git commit`, `git push`, `git checkout`, `git branch`, `git merge`, `git rebase`, etc.) without EXPLICIT user permission. This is an absolute rule with ZERO exceptions. Only the user initiates git operations
- **Verify Before Implementing**: ALWAYS verify APIs, library features, and configurations using Context7 or official documentation before implementation. NEVER assume attributes, methods, or behavior exist without verification
- **Documentation**: Use `docs/` folder for documentation
- **Ask Questions**: ALWAYS ask if unclear. NEVER assume. STOP and ask before proceeding if ANY of:
  - Multiple valid approaches exist
  - User intent could be interpreted multiple ways
  - Requirements are vague or incomplete
  - Design decisions needed (architecture, patterns, data models, APIs)
  - Trade-offs exist between options
  - Scope is ambiguous (what's in/out, how deep to go)

## Feature Workflow
1. **Research**: Understand the codebase, requirements, and constraints before making changes
   - Check existing patterns and implementations for similar functionality
   - Review related tests to understand expected behavior
   - Identify dependencies and potential side effects
2. **Plan**: Create an initial plan breaking down the task into clear, actionable steps
   - Create a markdown feature file in `docs/features/` named `YYYY-MM-DD-HHMM_FEATURE_NAME.md`
   - Use `date +%Y-%m-%d-%H%M` to get the timestamp (e.g., `docs/features/2025-11-26-1530_AUTHENTICATION.md`)
3. **Present Summary**: Present a brief plan summary to the user
   - Display: "Type `y` to go to clarifying"
   - If user adds context/feedback: immediately update the feature file
   - Continue showing the prompt until user types `y`
   - Only proceed to step 4 (Clarify) after user confirmation
4. **Clarify**: Ask questions to ensure complete understanding. REQUIRED before implementation if ANY ambiguity exists
   - Ask ONE question at a time, wait for answer, then ask the next question
   - Use previous answers to inform subsequent questions
   - Format each question as:
     ```
     **Question:** [question]?
     (1) [option]
     (2) [option]
     ```
     Mention that text answers are welcome (pick number, add context, or free-form text). Don't include "text answer" as a numbered option
   - Update the feature file with each Q&A after answering
   - Continue until ALL ambiguities resolved - don't stop after pre-written questions. Proactively identify new ambiguities and ask follow-ups. Don't ask permission to continue
   - Know when to stop: architecture, file structure, user-facing changes, breaking changes, major patterns - NOT minor implementation details
   - After all questions: comprehensively update plan with all decisions
   - NEVER skip if uncertain - defaulting to assumption is unacceptable
5. **Confirm**: Present the final plan summary and ask "Type `y` to implement this plan"
   - If "y": proceed to implementation
   - If other feedback: adjust the plan and ask for confirmation again
6. **Implement**: Execute the plan incrementally, following code style and architecture guidelines
   - Write tests alongside implementation
   - Make incremental commits for major milestones if working on large features
7. **Validate**: Run all quality gates in order to ensure correctness (see Quality Gates section)
   - If any gate fails: fix issues and re-run all gates from the beginning
8. **Complete**: After all quality gates pass, summarize changes made and ask about committing (see Version Control section)

## Code Style

### General Principles
- **Simplicity**: Straightforward solutions. No unnecessary intermediate variables—directly invoke/access if used once
- **Paradigm**: Functional only—pure functions, immutability, no classes/mutations
- **Duplicate Code**: Extract to reusable helpers
- **Dependencies**: Check existing before adding new. Prefer well-maintained. Document rationale for major ones

### Style & Formatting
- **Formatting**: [DETECT formatter and settings from project config files (biome.json, .prettierrc, .eslintrc, pyproject.toml, etc.) - e.g., "Biome (2 spaces, auto-organize imports)" or "Black (line length 100)" or "None - follow language standards"], empty line at end of files, whitespace between logical blocks
- **Property Ordering**: Alphabetical by default unless another ordering makes better sense. For mixed objects: primitives first, then nested (both alphabetically)

### Imports & Exports [JS/TS]
- **Imports**: `@/` for src/, `@@/` for package root, `./` for same directory only
- **Exports**: ALWAYS at end of file (EOF). Only export what's used elsewhere. Export shared types. Do not export unused code
  - Use inline `type` keyword in export statements: `export { functionName, type TypeName }`
  - Alphabetical ordering for exports (case-insensitive)
- **Default exports preferred**: Nearly every file has default export named as file
  - Named exports only for: types, constants alongside default, or utilities grouping together (rare)
  - Barrel files (index.ts): Only re-export actual consumer imports—remove unused
- **File Organization**: Remove folder if only index file—move up and rename to folder name. No `types.ts` files. Files named as default export
- **Type Location**: Define types in the module where they're **primarily used**, export for other modules to import

### Naming Conventions [JS/TS]
- **PascalCase**: Types/Interfaces/Classes (`OrderEvent`, `UserConfig`)
- **camelCase**: Functions/Variables/Constants (`processOrder`, `maxRetries`)
- **Descriptive Names**: Full names, not abbreviations—especially parameters. Exceptions: `i` (index), `error` (catch), single-letter generics (`T`, `K`, `V`)
- **Files**: Named as default export
- **Test Files**: Mirror source with `.test.ts` in `tests/`

### TypeScript Practices [JS/TS]
- **Types**: Strict, never `any` (use `unknown`). Prefer `type` over `interface`. Infer when obvious. No `types.ts` files—define inline, co-located with primary implementation
- **Type Assertions**: Prefer `satisfies` over `as`. Use type predicates for filters: `items.filter((item): item is NonNullable<typeof item> => item !== null)`
- **Variables**: Prefer `const`. Use `let` only for: lazy init singletons, error cleanup, loop counters, complex state
- **Inline Constants**: Inline strings/numbers used 2-3 times in one module. Extract only when cross-module, complex, or likely to change

### Functions & Control Flow [JS/TS]
- **Functions**: Arrow functions, implicit returns when possible
- **Callbacks**: Pass references directly if signatures match: `process.on("SIGINT", shutdown)`
- **Wrapper Functions**: Don't create functions called once at startup—execute at module scope. Don't wrap array functions—use single-item arrays
- **Async**: Prefer async/await
- **Loops**: Prefer functional (map, filter, reduce) over imperative (for, while)
- **Conditionals**: Combine related, reduce nesting. Single-line for simple cases

### Object & Data Handling [JS/TS]
- **Object Construction**: Spread dynamic FIRST, explicit LAST (explicit overrides): `{ ...dynamicProps, id: 123 }`
- **Redundant Variables**: Don't create multiple holding same value
- **String Building**: Array join for conditional concat (not `+=`)
- **Method Chaining**: Chain directly unless needed for clarity

### Comments & Documentation
- **When**: Explain "why" not "what"—business logic, workarounds, non-obvious decisions
- **Avoid**: NEVER restate code. If self-explanatory, no comment needed
- **TODOs**: `// TODO:` with context (optional ticket ref)

### Config & Environment
- **Config**: Env vars only, no secrets in code
- **Env Vars [JS/TS]**: ALWAYS update: `.env`, `.env.example`, `src/env.ts`. NEVER access `process.env` directly—import from `src/env.ts`

### Error Handling & Logging
- **Errors**: Graceful failures with structured logging. Include context (what failed, why, expected). Consider error codes for production
- **Logging**: Structured JSON via custom logger. Log: key ops, state changes, external calls, errors

### Testing [JS/TS]
- **Approach**: Write tests alongside implementation (TDD/test-first)
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
- **Test Quality**:
  - Write meaningful tests validating behavior/edge cases
  - Avoid trivial tests (testing that functions exist, mocked implementations without behavior verification)
  - Test behavior, not implementation details
  - Use descriptive test names: `"should throw error when orderId is missing"`
  - Group related tests with `describe` blocks
- **Validation**: Run `npm run test` after test changes

## Quality Gates [JS/TS]
Run in this order to fail fast:

1. TypeScript compilation must succeed with no errors (`npm run typecheck`)
2. Biome linting must pass (`npm run lint`)
3. All tests must pass and test coverage must meet minimum 95% threshold across all metrics (`npm run test`)
4. Project must build and run successfully (`npm run dev`)

## Version Control
- **NEVER do ANY git operation without explicit user permission** - This includes: commit, push, stage, unstage, branch operations, merges, rebases, etc.
- **Quality Gates Required**: Run ALL quality gates before ANY git operation. If any gate fails, inform the user and stop
- **When to Ask About Committing**: Ask when you feel like it makes sense
  - Logical unit complete (feature/bugfix/refactor/task finished)
  - Quality gates pass (or minimally, changes validated)
  - Before significantly different task
  - **Key principle**: When in doubt, ask. Only skip if certain larger commit coming
- **Commit Workflow**: NEVER commit automatically. Only ask when logical
  - Ask: "Type `y` to start committing"
  - If "y": Run quality gates first. If any gate fails, inform the user and stop. Then proceed with commit workflow:
    - Check staged files (`git status`, `git diff --staged`)
    - Display: files to unstage (if any), additional files to stage (if any), proposed commit message (conventional format describing ALL changes), horizontal rule (`---`)
    - Display options based on staging needs:
      - If staging changes needed (files to unstage or additional files to stage): Type `s` to stage | `c` to stage and commit | `p` to stage, commit and push
      - If no staging changes needed: Type `c` to commit | `p` to commit and push
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
```

## Project-Specific Sections (Generate)

```markdown
### Architecture
Analyze and document:
- Project purpose (from README/package.json)
- Key frameworks and libraries (from dependencies)
- External integrations (databases, APIs, queues)
- Architectural patterns

### Project Structure
- Only list key directories with descriptions
- Use a simple bullet list format (not a tree structure)
- Focus on adding context that explains purpose and architecture
- Example format:
  ```markdown
  ## Project Structure
  Key directories:
  - `src/services/` - Business logic and external service integrations
  - `src/db/` - Database models and migrations
  - `tests/` - Unit and integration tests
  ```
```

User input:
$ARGUMENTS
