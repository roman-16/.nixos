# Selective CI Deployment

## Problem
Currently, any file change (including `agents.md`) triggers a complete deployment of both:
- `event-handlers` (Cloud Functions)
- `server` (Cloud Run)

This is inefficient and causes unnecessary deployments when changes don't affect the deployed artifacts.

## Goal
Configure GitHub Actions to only deploy projects when their relevant files change.

## Current Understanding
Based on the OpenTofu output:
- Uses OpenTofu with GCS backend
- Deploys to GCP:
  - `google_cloud_run_v2_service.server` - main server container
  - `google_cloudfunctions_function.on_user_create` - event handler
  - `google_cloudfunctions_function.on_user_delete` - event handler
  - `google_cloudfunctions2_function.on_upsert` - event handler
  - `google_cloudfunctions2_function.on_delete` - event handler
- Docker image changes trigger Cloud Run updates (SHA comparison)

## Initial Plan

### Approach Options

**Option A: Path-based workflow triggers**
- Use GitHub Actions `paths` filter to only run workflows when relevant files change
- Separate workflows for `server` and `event-handlers`

**Option B: Monorepo change detection**
- Use a tool like `dorny/paths-filter` or `tj-actions/changed-files`
- Single workflow that conditionally deploys based on detected changes

**Option C: OpenTofu-only approach**
- Let OpenTofu determine what needs updating (current behavior)
- Optimize Docker builds to use cache effectively so unchanged code doesn't produce new image SHAs

**Option D: Hybrid approach**
- Path filters trigger specific jobs within a single workflow
- Matrix strategy for multiple deployable projects

## Questions to Clarify
1. Project structure - where are `event-handlers` and `server` source files located?
2. Current GitHub Actions workflow structure
3. Are there shared dependencies between projects?
4. Preference for separate workflows vs single workflow with conditional jobs?

## Decisions
(To be filled after clarification)

## Implementation
(To be filled after confirmation)
