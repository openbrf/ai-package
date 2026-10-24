import type { CSSProperties } from "react";

/**
 * The view's styles. Every colour, radius, shadow and typeface is a `--obrf-*`
 * design token, so a theme restyles the view with the rest of the interface,
 * and the styles are inline because the host's stylesheet holds only the
 * utility classes the host itself uses (the plugin contract, "Styling a
 * view").
 */

/** The namespace the host merges the package's translations under. */
export const NAMESPACE = "plugin-ai-package";

/** The smallest touch target the design system allows. */
const TOUCH = "44px";

export const styles = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: "1.25rem",
    padding: "1.25rem",
    background: "var(--obrf-surface-raised)",
    color: "var(--obrf-text-primary)",
    border: "1px solid var(--obrf-border-subtle)",
    borderRadius: "var(--obrf-radius-panel)",
    boxShadow: "var(--obrf-shadow-raised)",
    fontFamily: "var(--obrf-font-ui)",
  },
  heading: { margin: 0, fontSize: "1.125rem", fontWeight: 600 },
  subheading: { margin: 0, fontSize: "1rem", fontWeight: 600 },
  assistant: { display: "flex", flexDirection: "column", gap: "0.75rem" },
  muted: {
    margin: 0,
    fontSize: "0.875rem",
    color: "var(--obrf-text-secondary)",
  },
  notice: {
    margin: 0,
    padding: "0.25rem 0.75rem",
    fontSize: "0.875rem",
    color: "var(--obrf-text-primary)",
    borderLeft: "3px solid var(--obrf-status-info)",
  },
  failed: {
    margin: 0,
    fontSize: "0.875rem",
    color: "var(--obrf-status-danger)",
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  entry: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    padding: "0.75rem",
    border: "1px solid var(--obrf-border-subtle)",
    borderRadius: "var(--obrf-radius-control)",
  },
  person: { background: "var(--obrf-surface-sunken)" },
  who: {
    margin: 0,
    fontSize: "0.8125rem",
    fontWeight: 600,
    color: "var(--obrf-text-secondary)",
  },
  // The model's answer keeps its line breaks: it may hold a draft's
  // paragraphs.
  text: { margin: 0, fontSize: "0.9375rem", whiteSpace: "pre-wrap" },
  proposals: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    paddingTop: "0.5rem",
    borderTop: "1px solid var(--obrf-border-subtle)",
  },
  proposalsHeading: { margin: 0, fontSize: "0.875rem", fontWeight: 600 },
  proposal: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem 0.75rem",
  },
  link: {
    display: "inline-flex",
    alignItems: "center",
    minHeight: TOUCH,
    color: "var(--obrf-accent-trust)",
    fontWeight: 600,
  },
  form: { display: "flex", flexDirection: "column", gap: "0.5rem" },
  label: { fontSize: "0.875rem", fontWeight: 600 },
  textarea: {
    font: "inherit",
    fontSize: "0.9375rem",
    padding: "0.5rem 0.75rem",
    color: "var(--obrf-text-primary)",
    background: "var(--obrf-surface-page)",
    border: "1px solid var(--obrf-border-strong)",
    borderRadius: "var(--obrf-radius-control)",
    resize: "vertical",
  },
  toolbar: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  button: {
    minHeight: TOUCH,
    padding: "0.25rem 1rem",
    font: "inherit",
    fontSize: "0.875rem",
    color: "var(--obrf-text-primary)",
    background: "var(--obrf-surface-page)",
    border: "1px solid var(--obrf-border-strong)",
    borderRadius: "var(--obrf-radius-control)",
    cursor: "pointer",
  },
  primary: {
    color: "var(--obrf-on-accent-trust)",
    background: "var(--obrf-accent-trust)",
    borderColor: "var(--obrf-accent-trust)",
  },
} satisfies Record<string, CSSProperties>;
