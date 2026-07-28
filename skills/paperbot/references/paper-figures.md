# Paper figures

Use this component when a visual makes a workflow, architecture boundary,
comparison, or measured result materially easier to understand.

1. Prefer a compact inline SVG that remains in the versioned Markdown.
2. Use only inert shapes and text: `svg`, `g`, `path`, `rect`, `circle`,
   `ellipse`, `line`, `polyline`, `polygon`, `text`, `title`, and `desc`.
3. Add `role="img"`, an `aria-label`, and a `figcaption`.
4. Keep labels legible without relying on color alone.
5. Identify source data and method for plots.
6. Describe illustrative diagrams as illustrations, not measurements.

Do not include scripts, event handlers, CSS, animation, external images,
`foreignObject`, or reusable external resources.
