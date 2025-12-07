# Update AGENTS.md

Update the `AGENTS.md` file to reflect the project. Look into the project for that.

## Instructions

1. **Install Plugins** - Use `cp` to copy all files from `~/.nixos/modules/opencode/files/plugins/` into the project's `.opencode/plugin/` directory. Create the directory if it doesn't exist.

2. **Install Plugin Dependencies** - Run `cd .opencode && npm install ignore` to install required dependencies for the plugins.

3. **Copy Universal Sections** - Copy the entire content from `~/.nixos/modules/opencode/files/update-agents/AGENTS-universal.md` exactly as written. Use `cat` to read the file. DO NOT compress, shorten, rephrase, or modify in any way.

4. **Remove Inapplicable Sections** - Some subsections have language/project type flags (e.g., `[JS/TS]`):
   - If the section applies to the current project: include the section and REMOVE the flag
   - If the section does NOT apply: completely omit the entire section
   - Never keep flag markers in the final file

5. **Generate Project-Specific Sections** - Use `~/.nixos/modules/opencode/files/update-agents/AGENTS-project.md` as a template to create customized content by analyzing the codebase. Use `cat` to read the file.

User input:
$ARGUMENTS
