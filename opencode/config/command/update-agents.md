# Update AGENTS.md

Update the `AGENTS.md` file to reflect the project. Look into the project for that.

## Instructions

1. **Install Plugins** - Use `cp` to copy all files from `~/.nixos/opencode/files/plugins/` into the project's `.opencode/plugin/` directory. Create the directory if it doesn't exist.

2. **Copy Universal Sections** - Copy the entire content from `~/.nixos/opencode/files/update-agents/AGENTS-universal.md` exactly as written. Use `cat` to read the file. DO NOT compress, shorten, rephrase, or modify in any way.

3. **Remove Inapplicable Sections** - Some subsections have language/project type flags (e.g., `[JS/TS]`):
   - If the section applies to the current project: include the section and REMOVE the flag
   - If the section does NOT apply: completely omit the entire section
   - Never keep flag markers in the final file

4. **Generate Project-Specific Sections** - Use `~/.nixos/opencode/files/update-agents/AGENTS-project.md` as a template to create customized content by analyzing the codebase. Use `cat` to read the file.

5. **Verify Before Finishing**:
   - [ ] Plugins copied to `.opencode/plugin/`
   - [ ] Universal sections copied exactly (no compression/rewording)
   - [ ] Only inapplicable sections removed, all other content preserved
   - [ ] `[JS/TS]` flags removed from applicable sections
   - [ ] `[DETECT...]` placeholders replaced (Style & Formatting, Scope, Commands)
   - [ ] Sections generated (Architecture, Project Structure)
   - [ ] Section order maintained: General Principles → Workflow → Architecture → Project Structure → Code Style → Quality Gates → Version Control → Commands

User input:
$ARGUMENTS
