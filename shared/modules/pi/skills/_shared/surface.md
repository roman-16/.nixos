# The surface

The surface is everything the people outside the code touch. What it consists of depends on what the thing is. Establish it from what the thing shows the outside world - its README, its `--help`, the `bin` and `exports` of its manifest, its route table, its options schema - not from memory.

| The thing is | Its surface is |
| --- | --- |
| A bot or assistant | Messages sent and received, and what it does unprompted |
| A CLI | Commands and subcommands, flag and argument names, prompts, stdout and stderr shape, exit codes, config file, env vars |
| A library or SDK | Exported symbols, signatures, types, semantics, thrown errors, runtime requirements |
| A service or API | Routes, methods, request and response schemas, status codes, headers, auth, rate limits, webhooks |
| A system or config module | Options and their defaults, commands and aliases available, generated files and their paths, managed services, what runs at boot, manual steps it demands |
| A web app or UI | Screens, controls, flows, copy, shortcuts, notifications, what a click does |
| An agent skill or extension | What the user asks for, what the agent does with it, what comes back |
| Developer tooling (linter, test runner, build tool) | Its rules, its reports, its cache behavior, and the speed felt by the developer who runs it |

Two audiences mean two surfaces, and both count - a CLI that is also a library owes both.
