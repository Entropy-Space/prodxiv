# Project discovery

Use this component to establish what the product is before drafting claims.

1. Run `PAPERBOT_CMD tools repo_scan <repository> --format json`.
2. Review the selected paths. Rerun the scan with `--exclude` when sensitive,
   generated, vendored, or irrelevant files appear.
3. Identify the product surface, primary users visible in documentation,
   executable entry points, packages, tests, releases, and benchmark suites.
4. Record the repository revision and dirty state from the manifest.
5. Separate observed implementation from README or website positioning.
6. Produce a short evidence map: observation, supporting paths, confidence,
   and unresolved question.

Do not infer product motivation or intended users solely from implementation.
