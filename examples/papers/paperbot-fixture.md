---
schema_version: "1"
paper_id: "prodxiv:2607.0002"
title: "Paperbot Fixture: An Evidence-Linked Test Product"
summary: "A deliberately small product fixture used to exercise the complete Paperbot scan, drafting, validation, and website-rendering workflow."
authors:
  - name: "prodxiv contributors"
organization: "prodxiv"
published_at: "2026-07-27"
version: 1
status: "concept"
topics:
  - "developer_tools"
  - "testing"
license: "CC BY 4.0"
repository_url: "https://github.com/Entropy-Space/prodxiv"
evidence_bundle: "evidence/paperbot-fixture.json"
---

# Summary

The Paperbot fixture is a deliberately small test product inside the prodxiv
repository. It exists to make the repository-to-paper workflow reproducible
without presenting a toy program as a production system.

Its evidence bundle is checked in beside this paper. Claims identify whether
they are verified from files, inferred from incomplete implementation,
provided by the maintainers, or still missing evidence.

# Background

Paperbot needs fixtures that exercise documentation, source code, tests,
configuration, manifests, and benchmark inputs. This repository provides each
of those source categories in a form that is quick to scan and easy to inspect.

The repository README directly states that its purpose is to exercise
Paperbot's deterministic scanner. Evidence: `fixture_purpose`.

# Motivation

The prodxiv maintainers intentionally keep the fixture small so a failed scan,
unsupported claim, or broken evidence link can be understood without first
learning a realistic application. Evidence: `small_by_design`.

This is testing infrastructure rather than an independent commercial product.
Its value comes from exposing integration mistakes at the boundary between the
scanner, drafting agent, validator, and website.

# Related Work

The fixture follows the same role as a compact conformance repository or a
golden-file input: it supplies a stable example that several independently
implemented stages can process.

It does not attempt to replace tests for varied real repositories. Those tests
are still necessary to discover language, scale, privacy, and documentation
patterns that a controlled fixture cannot represent.

# Core Features

## Inspectable greeting behavior

The fixture exports a greeting function that interpolates the supplied name.
A Bun test checks the observable result for the name `Paperbot`. Evidence:
`greeting_behavior`.

## Multiple evidence categories

The repository contains documentation, a package manifest, source files, a
test, configuration, and a benchmark scenario. This allows the scanner to
classify several source types while keeping every input human-readable.

## Explicit uncertainty

The configuration selects a value named `fixture`, but the repository does not
establish what that mode changes at runtime. The evidence therefore records the
interpretation as inferred rather than verified. Evidence: `fixture_mode`.

# Architecture

The product is intentionally flat. A TypeScript source module implements its
observable greeting behavior, a Bun test imports that module, and small files
represent configuration and benchmark inputs.

Paperbot scans those inputs into a language-neutral evidence bundle. The
drafting workflow refers to stable claim and source identifiers, while the
canonical validator checks the paper and evidence bundle before Astro renders
the Markdown.

# Benchmarks

The benchmark input declares 100 iterations, but it contains no executable
measurement harness, environment description, raw samples, or results.
Evidence: `benchmark_setup_only`.

No performance conclusion can be drawn from that input. The evidence bundle
retains a `missing_evidence` claim for fixture performance so the absence
cannot be mistaken for a positive result. Evidence: `performance_unknown`.

# Insights and Lessons

A complete pipeline fixture should be small enough to debug but rich enough to
cross every important boundary. Separating claim state from fluent prose also
makes a useful failure visible: a sentence can sound plausible while its
evidence still says `inferred` or `missing_evidence`.

The fixture further demonstrates that benchmark-shaped code is not benchmark
evidence. Reproducible results require methodology and measurements, not only
an iteration count.

# Limitations

The fixture does not represent a useful standalone product, a large
repository, multiple languages, private code, or a long-lived revision
history. Its benchmark scenario does not measure anything.

The paper was completed by maintainers after Paperbot created the initial
structure. It tests agent-assisted authoring boundaries, not fully autonomous
paper generation.

# References

1. The fixture repository,
   `apps/paperbot/tests/fixtures/repository`.
2. The evidence bundle,
   `examples/papers/evidence/paperbot-fixture.json`.
3. The Paperbot workflow, `skills/paperbot/SKILL.md`.
