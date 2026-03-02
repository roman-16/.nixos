# Project-Specific Sections Template

Generate these sections by analyzing the codebase. Insert them in the correct position within the final `AGENTS.md`.

## Architecture
[Insert after Feature Workflow section]

Analyze and document:
- Project purpose (from README/package.json)
- Key frameworks and libraries (from dependencies)
- External integrations (databases, APIs, queues)
- Architectural patterns

Example:
```markdown
## Architecture
Kafka consumer service that processes order events and creates Zendesk records:
- **Events**: CloudEvents v1.0 specification with Avro schema serialization
- **Kafka**: Confluent Kafka consumer with Schema Registry integration
- **Zendesk**: Creates users and order custom object records via REST API
- **Secrets**: GCP Secret Manager for credentials
```

## Project Structure
[Insert after Architecture section]

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

Example:
```markdown
## Project Structure
Key directories:
- `.vitest/` - Test configuration and global mocks for external dependencies
- `schemas/` - Avro schema files for Kafka message serialization
- `src/config/` - Service configurations (Kafka, Schema Registry)
- `src/lib/` - Shared utilities (structured JSON logger)
- `src/services/` - Business logic (orderConsumer, zendeskService)
- `src/env.ts` - Environment variable validation and secret loading
- `tests/` - Test files mirroring `src/` structure
```
