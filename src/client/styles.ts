/**
 * Panel stylesheet.
 *
 * Every colour, border, shadow and radius comes from DSH's own alias tokens so
 * the section reads as part of the settings shell on both themes, instead of
 * hard-coding a private palette. The sheet is injected as one owned
 * `<style>` element and removed with the plugin fiber.
 *
 * @module dsh-data-migration/client/styles
 */

/** Stable element id so HMR and re-apply never register the sheet twice. */
export const STYLE_ELEMENT_ID = 'dsh-data-migration-styles'

const PREFIX = 'ddm'

/** Class names handed to the components; mirrors the sheet below. */
export const classes = {
  root: `${PREFIX}-root`,
  header: `${PREFIX}-header`,
  title: `${PREFIX}-title`,
  subtitle: `${PREFIX}-subtitle`,
  card: `${PREFIX}-card`,
  cardHead: `${PREFIX}-card-head`,
  cardTitle: `${PREFIX}-card-title`,
  cardHint: `${PREFIX}-card-hint`,
  field: `${PREFIX}-field`,
  label: `${PREFIX}-label`,
  row: `${PREFIX}-row`,
  input: `${PREFIX}-input`,
  grow: `${PREFIX}-grow`,
  button: `${PREFIX}-button`,
  primary: `${PREFIX}-primary`,
  link: `${PREFIX}-link`,
  danger: `${PREFIX}-danger`,
  chipRow: `${PREFIX}-chip-row`,
  chip: `${PREFIX}-chip`,
  chipNeutral: `${PREFIX}-chip-neutral`,
  chipWarn: `${PREFIX}-chip-warn`,
  chipDanger: `${PREFIX}-chip-danger`,
  chipBusiness: `${PREFIX}-chip-business`,
  chipSuccess: `${PREFIX}-chip-success`,
  callout: `${PREFIX}-callout`,
  calloutDanger: `${PREFIX}-callout-danger`,
  summary: `${PREFIX}-summary`,
  summaryGrid: `${PREFIX}-summary-grid`,
  summaryTerm: `${PREFIX}-summary-term`,
  summaryValue: `${PREFIX}-summary-value`,
  check: `${PREFIX}-check`,
  status: `${PREFIX}-status`,
  statusOk: `${PREFIX}-status-ok`,
  statusError: `${PREFIX}-status-error`,
  statusBusy: `${PREFIX}-status-busy`,
  result: `${PREFIX}-result`,
  mono: `${PREFIX}-mono`,
} as const

const css = `
.${classes.root}{display:flex;flex-direction:column;gap:14px;max-width:720px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary,#1f2328)}
.${classes.header}{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.${classes.title}{font-size:15px;font-weight:600}
.${classes.subtitle}{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px}
.${classes.card}{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:var(--dsw-shadow-lv1,0 1px 3px #00000014)}
.${classes.cardHead}{display:flex;align-items:center;justify-content:space-between;gap:10px}
.${classes.cardTitle}{font-size:13px;font-weight:600}
.${classes.cardHint}{color:var(--dsw-alias-label-tertiary,#8c959f);font-size:11px}
.${classes.field}{display:flex;flex-direction:column;gap:6px}
.${classes.label}{color:var(--dsw-alias-label-secondary,#57606a);font-size:12px;font-weight:500}
.${classes.row}{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.${classes.grow}{flex:1;min-width:0}
.${classes.input}{width:100%;box-sizing:border-box;padding:5px 10px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;transition:border-color .14s}
.${classes.input}::placeholder{color:var(--dsw-alias-label-tertiary,#8c959f)}
.${classes.input}:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 28%,transparent)}
.${classes.button}{appearance:none;flex:none;padding:5px 12px;border:1px solid var(--dsw-alias-border-l2,#d0d7de);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2328);font:inherit;font-size:13px;cursor:pointer;transition:background-color .14s,border-color .14s,opacity .14s}
.${classes.button}:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#0000000d)}
.${classes.button}:disabled{opacity:.45;cursor:default}
.${classes.primary}{border-color:transparent;background:var(--dsw-alias-button-primary-fill,#4a6cf7);color:var(--dsw-alias-label-primary-inverted,#fff)}
.${classes.primary}:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,#4a6cf7);filter:brightness(1.08)}
.${classes.danger}{border-color:var(--dsw-alias-state-error-primary,#d64545);background:var(--dsw-alias-state-error-primary,#d64545);color:var(--dsw-alias-label-primary-inverted,#fff)}
.${classes.danger}:hover:not(:disabled){background:var(--dsw-alias-state-error-primary,#d64545);filter:brightness(1.08)}
.${classes.link}{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary-bluish,var(--dsw-alias-button-primary-fill,#4a6cf7));font:inherit;font-size:12px;padding:0;cursor:pointer}
.${classes.link}:hover:not(:disabled){text-decoration:underline}
.${classes.chipRow}{display:flex;flex-wrap:wrap;gap:6px}
.${classes.chip}{white-space:nowrap;border:1px solid transparent;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500}
.${classes.chipNeutral}{color:var(--dsw-alias-label-secondary,#57606a);background:color-mix(in srgb,var(--dsw-alias-label-primary,#1f2328) 6%,transparent)}
.${classes.chipSuccess}{color:var(--dsw-alias-state-success-primary,#2f9e6e);background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e6e) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2f9e6e) 24%,transparent)}
.${classes.chipWarn}{color:var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 24%,transparent)}
.${classes.chipDanger}{color:var(--dsw-alias-state-error-primary,#d64545);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 26%,transparent)}
.${classes.chipBusiness}{color:var(--dsw-alias-state-business-primary,#4a5fa8);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4a5fa8) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4a5fa8) 22%,transparent)}
.${classes.callout}{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 26%,transparent);border-left:3px solid var(--dsw-alias-state-warn-primary,#b45309);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b45309) 7%,transparent);color:var(--dsw-alias-state-warn-primary,#b45309);border-radius:8px;padding:8px 12px;font-size:12px}
.${classes.calloutDanger}{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 26%,transparent);border-left-color:var(--dsw-alias-state-error-primary,#d64545);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d64545) 7%,transparent);color:var(--dsw-alias-state-error-primary,#d64545)}
.${classes.summary}{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--dsw-alias-border-l1,#e1e5ea);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#f2f4f7)}
.${classes.summaryGrid}{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;font-size:12px}
.${classes.summaryTerm}{color:var(--dsw-alias-label-secondary,#57606a)}
.${classes.summaryValue}{color:var(--dsw-alias-label-primary,#1f2328);overflow-wrap:anywhere}
.${classes.check}{display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a);cursor:pointer}
.${classes.check} input{margin-top:2px;accent-color:var(--dsw-alias-button-primary-fill,#4a6cf7)}
.${classes.mono}{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow-wrap:anywhere}
.${classes.status}{min-height:18px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8c959f)}
.${classes.statusOk}{color:var(--dsw-alias-state-success-primary,#2f9e6e)}
.${classes.statusError}{color:var(--dsw-alias-state-error-primary,#d64545)}
.${classes.statusBusy}{color:var(--dsw-alias-label-secondary,#57606a)}
.${classes.result}{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
.${classes.button}:focus-visible,.${classes.input}:focus-visible,.${classes.link}:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-button-primary-fill,#4a6cf7) 60%,transparent);outline-offset:1px}
@media (prefers-reduced-motion:reduce){.${classes.button},.${classes.input}{transition:none}}
`

/**
 * Install the panel stylesheet once.
 * @returns a disposer removing the sheet when this plugin unloads.
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(STYLE_ELEMENT_ID)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.id = STYLE_ELEMENT_ID
  tag.dataset.plugin = 'dsh-data-migration'
  tag.textContent = css
  document.head.appendChild(tag)
  return () => {
    tag.remove()
  }
}
