---
description: Update AGENTS.md to reflect the latest changes
agent: build
---

Update the `AGENTS.md` file to reflect the project. Look into the project for that.

Compress content if needed but don't delete any. Add content if needed. Keep the file clean, small and simple.

The first thing in `AGENTS.md` should be commands which list the most important commands of the project. Update it if needed.

In second thing in `AGENTS.md` include a workflow section with the following content:

```
1. **Research**: Understand the codebase, requirements, and constraints before making changes
2. **Plan**: Break down the task into clear, actionable steps. ALWAYS create a markdown file with the plan
3. **Clarify**: Ask clarifying questions about the feature to ensure complete understanding
   - a. Present questions ONE AT A TIME with 4 multiple-choice options that the user can select by typing "1", "2", "3", or "4"
   - b. Users can also answer in their own words instead of selecting a number
   - c. Add each question and its answer to the plan file before moving to the next question
   - d. Continue until ALL questions have been answered and you are 95% sure you can implement
   - e. Rework the plan with the answered questions in mind
   - f. Ask "Should I continue with this plan? (y)" and wait for user confirmation with "y" before proceeding
4. **Implement**: If "y" was selected, execute the plan incrementally while keeping the plan in mind, following code style and architecture guidelines
5. **Validate**: Run quality gates (type check, lint, tests, build) to ensure correctness
```

Include a overview of the project structure with descriptions for each folder/file next to it. Use `tree` to do that but ignore dependencies. Don't include the complete result, just the most important parts.

List your MCP servers and group them by service, add these services with all their functions to the `AGENTS.md` file with a small what comment what each thing does.

User input to add to the `AGENTS.md` file as content, rewrite it if needed:
$ARGUMENTS
