// Shared DiffView component for rendering git diffs with syntax highlighting.
// Wraps opentui's <diff> element with theme-aware colors and syntax styles.
// Supports split and unified view modes with line numbers.

import * as React from "react"
import { RGBA, SyntaxStyle, type DiffRenderable, type LineNumberRenderable, type LineColorConfig } from "@opentuah/core"
import { getSyntaxTheme, getResolvedTheme, rgbaToHex } from "../themes.js"
import { balanceDelimiters } from "../balance-delimiters.js"

export interface DiffViewRef {
  getDiffRenderable(): DiffRenderable | null
}

export interface DiffViewProps {
  diff: string
  view: "split" | "unified"
  filetype?: string
  themeName: string
  /** Wrap mode for long lines (default: "word") */
  wrapMode?: "word" | "char" | "none"
  /** Enable italics in syntax highlighting (default: true) */
  italicsEnabled?: boolean
  /** Use the terminal's default background instead of theme panel backgrounds */
  transparentBackground?: boolean
  /** Whether the diff pane is focused and should show the cursor line */
  focused?: boolean
  /** 0-based logical line index of the cursor */
  cursorLine?: number
  /** Inclusive start/end of the current selection, or null */
  selection?: { start: number; end: number } | null
  /** Background color for the cursor line (defaults to the sidebar active-file color) */
  cursorColor?: string
  /** Background color for selected lines (defaults to selectionBg) */
  selectionColor?: string
}

type PrivateDiffRenderable = DiffRenderable & {
  leftSide?: LineNumberRenderable
  rightSide?: LineNumberRenderable
}

function getSideLineColorConfig(
  side: LineNumberRenderable | undefined,
  line: number,
): LineColorConfig | null {
  if (!side) return null
  const { gutter, content } = side.getLineColors()
  const g = gutter.get(line)
  const c = content.get(line)
  if (!g && !c) return null
  const config: LineColorConfig = {}
  if (g) config.gutter = g
  if (c) config.content = c
  return config
}

function snapshotLineColors(
  diffRenderable: DiffRenderable,
  line: number,
): { left: LineColorConfig | null; right: LineColorConfig | null } {
  const { leftSide, rightSide } = diffRenderable as unknown as PrivateDiffRenderable
  return {
    left: getSideLineColorConfig(leftSide, line),
    right: getSideLineColorConfig(rightSide, line),
  }
}

function isTransparent(color: RGBA | string | undefined): boolean {
  if (!color) return true
  if (typeof color === "string") return color.toLowerCase() === "transparent" || color === "#00000000"
  return color.a === 0
}

function restoreSideLineColor(
  side: LineNumberRenderable | undefined,
  line: number,
  color: LineColorConfig | null,
): void {
  if (!side) return
  const hasVisibleColor = color && (
    (color.gutter && !isTransparent(color.gutter)) ||
    (color.content && !isTransparent(color.content))
  )
  if (hasVisibleColor) {
    side.setLineColor(line, color)
  } else {
    side.clearLineColor(line)
  }
}

function restoreLineColors(
  diffRenderable: DiffRenderable,
  line: number,
  base: { left: LineColorConfig | null; right: LineColorConfig | null },
): void {
  const { leftSide, rightSide } = diffRenderable as unknown as PrivateDiffRenderable
  restoreSideLineColor(leftSide, line, base.left)
  restoreSideLineColor(rightSide, line, base.right)
}
function getLuminance(color: RGBA): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
}

function getColorDistance(a: RGBA, b: RGBA): number {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/**
 * Compute a visible word-highlight color from a line background.
 * Uses stronger contrast than opentui's default brighten(1.1), which is too subtle
 * on very dark themes (especially in HTML screenshots/web output).
 */
function getWordHighlightBg(base: RGBA): string {
  const baseLuminance = getLuminance(base)

  // Light backgrounds: darken slightly while preserving hue.
  // This avoids chalky white patches that can look noisy.
  if (baseLuminance >= 0.52) {
    return rgbaToHex(base.brighten(0.9))
  }

  // Dark backgrounds: use stronger hue-preserving brightening than opentui default (1.1),
  // which is often imperceptible on near-black diff backgrounds.
  let candidate = base.brighten(2.4)
  let luminanceDelta = Math.abs(getLuminance(candidate) - baseLuminance)

  // Keep a minimum luminance delta close to github-light perceptibility.
  if (luminanceDelta < 0.09) {
    candidate = base.brighten(3.0)
    luminanceDelta = Math.abs(getLuminance(candidate) - baseLuminance)
  }

  if (luminanceDelta < 0.09) {
    candidate = base.brighten(3.6)
  }

  // Pure-black (or near-black) bases stay unchanged with multiplicative brighten.
  // Add a tiny additive lift so inline highlights remain visible on those themes.
  if (getColorDistance(candidate, base) < 0.03) {
    candidate = RGBA.fromValues(
      base.r + (1 - base.r) * 0.12,
      base.g + (1 - base.g) * 0.12,
      base.b + (1 - base.b) * 0.12,
      base.a,
    )
  }

  return rgbaToHex(candidate)
}

export const DiffView = React.forwardRef<DiffViewRef, DiffViewProps>(function DiffView(
  {
    diff,
    view,
    filetype,
    themeName,
    wrapMode = "word",
    italicsEnabled = true,
    transparentBackground = false,
    focused = false,
    cursorLine = 0,
    selection = null,
    cursorColor,
    selectionColor,
  },
  ref,
): React.ReactNode {
  const diffRef = React.useRef<DiffRenderable | null>(null)

  React.useImperativeHandle(ref, () => ({
    getDiffRenderable: () => diffRef.current,
  }))
  // Balance paired delimiters (backticks, triple quotes, etc.) before
  // passing to <diff> so tree-sitter doesn't misparse hunks that start
  // inside a multi-line string
  const balancedDiff = React.useMemo(
    () => balanceDelimiters(diff, filetype),
    [diff, filetype],
  )

  // Memoize theme lookups to ensure stable references
  const resolvedTheme = React.useMemo(
    () => getResolvedTheme(themeName),
    [themeName],
  )
  const syntaxStyle = React.useMemo(
    () => SyntaxStyle.fromStyles(getSyntaxTheme(themeName, "dark", italicsEnabled)),
    [themeName, italicsEnabled],
  )

  // Convert RGBA to hex for diff component props
  const transparentBg = React.useMemo(() => RGBA.fromInts(0, 0, 0, 0), [])
  const colors = React.useMemo(() => ({
    text: rgbaToHex(resolvedTheme.text),
    bgPanel: transparentBackground ? transparentBg : rgbaToHex(resolvedTheme.backgroundPanel),
    diffAddedBg: rgbaToHex(resolvedTheme.diffAddedBg),
    diffRemovedBg: rgbaToHex(resolvedTheme.diffRemovedBg),
    diffLineNumber: rgbaToHex(resolvedTheme.diffLineNumber),
    diffAddedLineNumberBg: rgbaToHex(resolvedTheme.diffAddedLineNumberBg),
    diffRemovedLineNumberBg: rgbaToHex(resolvedTheme.diffRemovedLineNumberBg),
  }), [resolvedTheme, transparentBackground, transparentBg])

  const wordHighlights = React.useMemo(() => ({
    addedWordBg: getWordHighlightBg(resolvedTheme.diffAddedBg),
    removedWordBg: getWordHighlightBg(resolvedTheme.diffRemovedBg),
  }), [resolvedTheme])

  const activeCursorColor = React.useMemo(() => {
    if (cursorColor) return cursorColor
    // Match the sidebar's active-file background so the focused cursor line
    // feels visually consistent with the file navigator.
    return rgbaToHex(resolvedTheme.primary.brighten(0.3))
  }, [cursorColor, resolvedTheme.primary])

  const activeSelectionColor = React.useMemo(() => {
    return selectionColor ?? "#264F78"
  }, [selectionColor])

  // Track previously-applied highlights so we can restore the original diff
  // background colors instead of leaving lines blank after the cursor moves.
  interface SideBaseColor {
    left: LineColorConfig | null
    right: LineColorConfig | null
  }

  const prevCursorRef = React.useRef<{ line: number; base: SideBaseColor } | null>(null)
  const prevSelectionRef = React.useRef<{ start: number; end: number; color: string; base: Map<number, SideBaseColor> } | null>(null)

  // Reset highlight tracking when the underlying diff surface is rebuilt so
  // we do not try to clear lines on a stale renderable.
  React.useEffect(() => {
    prevCursorRef.current = null
    prevSelectionRef.current = null
  }, [diff, view, themeName])

  // Apply cursor line and selection highlights to the underlying DiffRenderable.
  React.useEffect(() => {
    const diffRenderable = diffRef.current
    if (!diffRenderable) return

    // Restore previous cursor override.
    if (prevCursorRef.current) {
      restoreLineColors(diffRenderable, prevCursorRef.current.line, prevCursorRef.current.base)
    }

    // Restore previous selection overrides.
    if (prevSelectionRef.current) {
      const { start, end, base } = prevSelectionRef.current
      for (let line = start; line <= end; line++) {
        restoreLineColors(diffRenderable, line, base.get(line) ?? { left: null, right: null })
      }
    }

    prevCursorRef.current = null
    prevSelectionRef.current = null

    if (!focused) return

    // Snapshot the cursor line's base color before applying any override.
    const cursorBase = snapshotLineColors(diffRenderable, cursorLine)

    // Snapshot and apply selection range.
    if (selection) {
      const start = Math.min(selection.start, selection.end)
      const end = Math.max(selection.start, selection.end)
      if (end >= start) {
        const selectionBase = new Map<number, SideBaseColor>()
        for (let line = start; line <= end; line++) {
          selectionBase.set(line, snapshotLineColors(diffRenderable, line))
        }
        diffRenderable.highlightLines(start, end, activeSelectionColor)
        prevSelectionRef.current = { start, end, color: activeSelectionColor, base: selectionBase }
      }
    }

    diffRenderable.setLineColor(cursorLine, activeCursorColor)
    prevCursorRef.current = { line: cursorLine, base: cursorBase }
  }, [focused, cursorLine, selection, activeCursorColor, activeSelectionColor])

  return (
    <box key={themeName} style={{ backgroundColor: colors.bgPanel }}>
      <diff
        ref={diffRef}
        diff={balancedDiff}
        view={view}
        fg={colors.text}
        treeSitterClient={undefined}
        filetype={filetype}
        syntaxStyle={syntaxStyle}
        showLineNumbers
        wrapMode={wrapMode}
        // `addedBg`/`removedBg` are used by opentui as the base colors for word-level highlights.
        // We set them to match the content backgrounds so light themes don't inherit dark defaults.
        addedBg={colors.diffAddedBg}
        removedBg={colors.diffRemovedBg}
        contextBg={colors.bgPanel}
        // Use explicit word highlight colors to avoid near-invisible defaults on dark themes.
        addedWordBg={wordHighlights.addedWordBg}
        removedWordBg={wordHighlights.removedWordBg}
        addedContentBg={colors.diffAddedBg}
        removedContentBg={colors.diffRemovedBg}
        contextContentBg={colors.bgPanel}
        lineNumberFg={colors.diffLineNumber}
        lineNumberBg={colors.bgPanel}
        addedLineNumberBg={colors.diffAddedLineNumberBg}
        removedLineNumberBg={colors.diffRemovedLineNumberBg}
        selectionBg="#264F78"
        selectionFg="#FFFFFF"
      />
    </box>
  )
})

