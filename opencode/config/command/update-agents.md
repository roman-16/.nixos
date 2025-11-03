---
description: Create or update AGENTS.md to reflect the latest project structure and guidelines
agent: build
---

Update the `AGENTS.md` file to reflect the project. Look into the project for that.

Compress content if needed but don't delete any. Add content if needed. Keep the file clean, small and simple. You can update anything if needed.

**Section Flags**: Some subsections are marked with language/project type flags (e.g., `[JS/TS]`). Only include these sections if they apply to the project type. Omit them for non-matching projects.

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
- **Ask Questions**: ALWAYS ask if unclear. NEVER assume. STOP and ask before proceeding if ANY of:
  - Multiple valid approaches exist
  - User intent could be interpreted multiple ways
  - Requirements are vague or incomplete
  - Design decisions needed (architecture, patterns, data models, APIs)
  - Trade-offs exist between options
  - Scope is ambiguous (what's in/out, how deep to go)

## Workflow
1. **Research**: Understand the codebase, requirements, and constraints before making changes
   - Check existing patterns and implementations for similar functionality
   - Review related tests to understand expected behavior
   - Identify dependencies and potential side effects
2. **Plan**: Create an initial plan breaking down the task into clear, actionable steps
   - For complex features (significant architectural changes, 3+ files affected, new external integrations), create a markdown plan file named `FEATURE_NAME_PLAN.md` (e.g., `AUTHENTICATION_PLAN.md`)
   - For simpler tasks, a clear written plan in the conversation is sufficient
3. **Clarify**: Ask questions to ensure complete understanding. REQUIRED before implementation if ANY ambiguity exists
   - Ask as many questions as needed - no limit on number of questions or choices per question
   - Present each question with numbered multiple-choice options (user can select by number or provide custom answer)
   - Format: "**Question:** [clear question]? (1) [option] (2) [option] (3) [option]... - or describe your preference"
   - Add each Q&A to the plan file (if created) or conversation
   - Continue until ALL ambiguities resolved
   - Update plan with clarified requirements
   - NEVER skip this step if uncertain - defaulting to an assumption is unacceptable
4. **Confirm**: Present the final plan and ask "Type `y` to implement this plan"
   - If "y": proceed to implementation
   - If other feedback: adjust the plan and ask for confirmation again
5. **Implement**: Execute the plan incrementally, following code style and architecture guidelines
   - Write tests alongside implementation
   - Make incremental commits for major milestones if working on large features
6. **Validate**: Run all quality gates in order to ensure correctness (see Quality Gates section)
   - If any gate fails: fix issues and re-run all gates from the beginning
7. **Complete**: After all quality gates pass, summarize changes made and ask about committing (see Version Control section)

## Code Style

### General Principles
- **Simplicity**: Prefer straightforward solutions. Eliminate unnecessary intermediate variables - directly invoke/access when only used once
- **Paradigm**: Functional programming only - pure functions, immutability, no classes/mutations
- **Duplicate Code**: Extract repeated patterns into reusable helpers
- **Dependencies**: Check if existing dependencies solve the problem before adding new ones. Prefer well-maintained libraries. Document rationale for major dependencies

### Style & Formatting
- **Formatting**: [DETECT formatter and settings from project config files (biome.json, .prettierrc, .eslintrc, pyproject.toml, etc.) - e.g., "Biome (2 spaces, auto-organize imports)" or "Black (line length 100)" or "None - follow language standards"], empty line at end of files, whitespace between logical blocks
- **Property Ordering**: Alphabetical by default unless another ordering makes better sense. For mixed objects: primitives first, then nested (both alphabetically)

### Imports & Exports [JS/TS]
- **Imports**: [DETECT: e.g., "`@/` for src/, `./` for same directory only"]
- **Exports**: At end of files. Only export what's used elsewhere. Export shared types

### Naming Conventions [JS/TS]
- **Types/Interfaces/Classes**: PascalCase (e.g., `OrderEvent`, `UserConfig`)
- **Functions/Variables/Constants**: camelCase (e.g., `processOrder`, `maxRetries`, `kafkaConfig`)
- **Files**: Named as the default export
- **Test Files**: Mirror source structure with `.test.ts` suffix

### TypeScript Practices [JS/TS]
- **Types**: Strict TypeScript, never `any` - use `unknown` or proper types
  - Prefer `type` over `interface`
  - Let TypeScript infer types when obvious
  - Don't duplicate type definitions
- **Variables**: Prefer `const` over `let`
  - Only use `let` for: singletons with lazy init, error handling/cleanup reassignments, loop counters, complex state management

### Functions & Control Flow [JS/TS]
- **Functions**: Arrow functions preferred. Use implicit returns when possible
- **Callback Wrappers**: Pass function references directly when signatures match
  ```ts
  // Good
  process.on("SIGINT", shutdown)
  // Bad
  process.on("SIGINT", () => shutdown())
  ```
- **Async**: Prefer async/await over callbacks/promises
- **Redundant Async**: Only use async/await when adding error handling or sequencing logic
- **Conditional Logic**: Combine related conditions - reduce nesting. Prefer single-line statements for simple conditions
  ```ts
  // Good for simple cases
  if (!value) throw new Error('Value required');
  // Also fine for complex error messages or when adding context
  if (!value) {
    throw new Error('Value required: provide a non-empty string');
  }
  ```

### Object & Data Handling [JS/TS]
- **Object Construction**: Generally spread dynamic properties FIRST, explicit properties LAST (unless intentionally allowing overrides)
  ```ts
  // Preferred: explicit properties override spreads
  const obj = { ...dynamicProps, id: 123, name: "fixed" }
  // Avoid: spreads can override explicit properties (unless intentional)
  const obj = { id: 123, name: "fixed", ...dynamicProps }
  ```
- **Redundant Variables**: Don't create multiple variables holding same value
- **String Building**: Use array join for conditional concatenation instead of `+=`
- **Method Chaining**: Chain directly instead of storing intermediate results (unless needed for clarity/reuse)

### Comments & Documentation
- **When to Comment**: Explain "why" not "what" - document business logic, workarounds, non-obvious decisions
- **Avoid**: Redundant comments that restate code (e.g., `// increment counter` above `counter++`)
- **TODOs**: Use `// TODO:` (or language-appropriate format) with context and optionally a ticket reference

### Config & Environment
- **Config**: Environment variables only, no secrets in code
- **Environment Variables [JS/TS]**: When adding/updating, ALWAYS update: `.env`, `.env.example`, and `src/env.ts`. NEVER access `process.env` directly - import from `src/env.ts`

### Error Handling & Logging
- **Error Handling**: Graceful failures with structured logging
- **Error Messages**: Include context in error messages (what failed, why, what was expected). Consider adding error codes for production debugging
- **Logging**: Structured JSON logging via custom logger. Log key operations, state changes, external calls, and errors for observability

### Testing [JS/TS]
- **Approach**: Write tests alongside implementation - test-driven or test-first
- **Location**: `.test.ts` files in `tests/` directory, mirroring `src/` structure
- **Coverage**: Minimum 95% coverage across all metrics
- **Test Quality**:
  - Write meaningful tests validating behavior/edge cases
  - Avoid trivial tests (testing that functions exist, mocked implementations without behavior verification)
  - Test behavior, not implementation details
  - Use descriptive test names: `"should throw error when orderId is missing"`
  - Mock external services (Kafka, Zendesk, Schema Registry); use real implementations for internal logic
  - Group related tests with `describe` blocks
- **Validation**: Run `npm run test:coverage` after test changes

## Quality Gates [JS/TS]
Run in this order to fail fast:

1. TypeScript compilation must succeed with no errors (`npm run typecheck`)
2. Biome linting must pass (`npm run lint`)
3. All tests must pass and test coverage must meet minimum 95% threshold across all metrics (`npm run test:coverage`)
4. Project must build and run successfully (`npm run dev`)

## Version Control
- **Commit Workflow**: NEVER commit automatically. Only ask when logical
  - Before asking: check staged files (`git status`, `git diff --staged`)
  - Display: additional files to stage (if any), proposed commit message (conventional format describing ALL changes), horizontal rule (`---`)
  - Display options:
    - Type `c` to commit
    - Type `p` to commit and push
  - On "c": stage additional files and commit
  - On "p": stage additional files, commit and push
  - On other response: treat as instruction (modify message, change files, make more changes, etc.)
- **When to Ask About Committing**: Ask when task complete AND no clear indication more changes coming
  - Logical unit complete (feature/bugfix/refactor/task finished)
  - Quality gates pass (or minimally, changes validated)
  - Before significantly different task
  - **Key principle**: When in doubt, ask. Only skip if certain larger commit coming
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
- **Test**: `npm test` | `npm run test:watch` | `npm run test:coverage`
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
- Run `tree` to analyze the project structure
- Document only the important directories and key files
- Exclude dependencies, build artifacts, cache and version control folders
- Add inline comments describing the purpose of each directory/file
```

User input to add:
$ARGUMENTS
