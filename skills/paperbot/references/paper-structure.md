# Paper structure

Use this component to assemble or revise the complete product paper.

1. Use this required order: Summary, Background, Motivation, Related Work,
   Core Features, Insights and Lessons, Limitations, and References. Put an
   optional Benchmarks section before Insights and Lessons.
2. Support material claims with repository evidence, public sources, or
   approved author statements.
3. Keep unanswered questions and uncertain inferences visible.
4. Omit Benchmarks unless reproducible methodology or results exist.
5. Keep Limitations direct and specific.
6. Preserve deliberate author edits when revising an existing paper.
7. Run `PAPERBOT_CMD tools paper_validate <paper.md> --profile draft --format json`.

Write on behalf of the credited product authors: after identifying the product,
use `we`, `our`, and `us` for their work and decisions. Keep the underlying
evidence neutral and do not invent intent to complete the first-person
narrative. Make the problem the organizing idea: Background explains the
problem, Motivation explains how and why the authors pursue the solution,
Related Work compares approaches to the same problem, and Core Features maps
mechanisms back to problem constraints.

Do not use polished prose to hide incomplete evidence.
