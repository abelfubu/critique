// Tests for DiffView theme reactivity when switching themes at runtime.

import * as React from "react"
import { afterEach, describe, expect, it } from "bun:test"
import { act } from "react"
import { testRender } from "@opentuah/react/test-utils"
import { getDataPaths } from "@opentuah/core"
import { DiffView } from "./diff-view.js"
import { useAppStore } from "../store.js"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

// Suppress EventTarget memory leak warning from opentui DataPathsManager —
// each DiffView registers a paths:changed listener during tree-sitter init
getDataPaths().setMaxListeners(50)

const sampleDiff = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
-old
+new
 keep
`

const wordHighlightDiff = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-const value = oldName + 1
+const value = newName + 1
`

const databaseRegressionDiff = `--- cli/src/database.ts
+++ cli/src/database.ts
@@ -9,17 +9,18 @@
 import dedent from "string-dedent";
 import { browserLogin } from "./tinybird-browser-login.ts";
 import { loadTinybirdResources } from "./tinybird-resources.ts";
 import { deployTinybirdResources, getDeploymentManagedReadToken, TinybirdClient } from "./tinybird.ts";
 import { requireAuth } from "./config.ts";
 import { getApiClient } from "./api-client.ts";
-import { ensureDefaultOrg } from "./projects.ts";
+import { resolveCurrentOrg } from "./orgs.ts";
 
 export interface DatabaseCreateOptions {
   token?: string;
   baseUrl?: string;
+  force?: boolean;
 }
 
 function getTinybirdEnvAuth() {
   const token = process.env.TINYBIRD_TOKEN || process.env.TB_TOKEN
   const baseUrl = process.env.TINYBIRD_BASE_URL || process.env.TINYBIRD_HOST || process.env.TB_HOST
   if (!token) return null
@@ -47,12 +48,13 @@
 
       For non-interactive Tinybird auth, pass --token and --base-url directly.
      \`,
   )
   .option("-t, --token [token]", "Tinybird workspace admin token (skips browser login)")
   .option("-u, --base-url [url]", "Tinybird API base URL (e.g. https://api.us-east.aws.tinybird.co)")
+  .option("-f, --force", "Overwrite existing database config without confirmation")
   .example("# Interactive setup (opens browser)")
   .example("strada database create")
   .example("# Non-interactive with existing token")
   .example("strada database create --token p.eyXXX --base-url https://api.tinybird.co")
   .action((options, context) => databaseCreateAction(options, context));
 
@@ -84,19 +86,46 @@
     clack.log.error((e as Error).message);
     return proc.exit(1);
   }
 
   // Create a default personal org on first use so \`strada login\` -> \`strada database create\`
   // works end to end without a manual org bootstrap step.
-  const org = await ensureDefaultOrg().catch((error) => error as Error);
+  const org = await resolveCurrentOrg().catch((error) => error as Error);
   if (org instanceof Error) {
     clack.log.error(org.message);
     return proc.exit(1);
   }
   clack.log.info(\`Using organization: \${cyan(org.name)}\`);
 
+  // Check if this org already has a configured database. If so, require
+  // explicit confirmation (interactive) or --force (non-interactive) to
+  // prevent accidental overwrites of Tinybird tokens.
+  if (!options.force) {
+    const { safeFetch: checkFetch } = getApiClient();
+    const existingDb = await checkFetch("/api/v0/orgs/:orgId/database", {
+      params: { orgId: org.id },
+    });
+    if (!(existingDb instanceof Error) && (existingDb.hasAdminToken || existingDb.hasReadToken)) {
+      const endpoint = existingDb.tinybirdEndpoint || existingDb.clickhouseUrl || "unknown";
+      if (!process.stdin.isTTY) {
+        clack.log.error(
+          \`This org already has a configured \${existingDb.backend} database (\${endpoint}).\\n\` +
+          \`  Pass --force to overwrite it.\`,
+        );
+        return proc.exit(1);
+      }
+      const overwrite = await clack.confirm({
+        message: \`This org already has a configured \${existingDb.backend} database (\${endpoint}). Overwrite it?\`,
+      });
+      if (clack.isCancel(overwrite) || !overwrite) {
+        clack.outro("Cancelled. Existing database config is unchanged.");
+        return proc.exit(0);
+      }
+    }
+  }
+
   // Authenticate with Tinybird
   const auth = await (async () => {
     if (options.token && options.baseUrl) {
       clack.log.info(\`Using provided token for \${options.baseUrl}\`);
       return { token: options.token, baseUrl: options.baseUrl };
     }
@@ -235,13 +264,13 @@
     requireAuth();
   } catch (e) {
     clack.log.error((e as Error).message);
     return proc.exit(1);
   }
 
-  const org = await ensureDefaultOrg().catch((error) => error as Error);
+  const org = await resolveCurrentOrg().catch((error) => error as Error);
   if (org instanceof Error) {
     clack.log.error(org.message);
     return proc.exit(1);
   }
   clack.log.info(\`Using organization: \${cyan(org.name)}\`);
 `

function ThemeToggleHarness() {
  const themeName = useAppStore((s) => s.themeName)

  return (
    <DiffView
      diff={sampleDiff}
      view="unified"
      filetype="txt"
      themeName={themeName}
    />
  )
}

function extractDiffBackgroundSample(frame: any) {
  return {
    removedLineNumberBg: Array.from(frame.lines[0]!.spans[0]!.bg.buffer),
    removedContentBg: Array.from(frame.lines[0]!.spans[4]!.bg.buffer),
    contextBg: Array.from(frame.lines[2]!.spans[0]!.bg.buffer),
  }
}

function getLineWithToken(frame: any, token: string) {
  return frame.lines.find((line: any) =>
    line.spans.map((span: any) => span.text).join("").includes(token),
  )
}

function getWordHighlightDistance(frame: any) {
  const removedLine = getLineWithToken(frame, "old")
  const addedLine = getLineWithToken(frame, "new")

  if (!removedLine || !addedLine) {
    throw new Error("Expected both added and removed lines in rendered frame")
  }

  const removedWord = removedLine.spans.find((span: any) => span.text === "old")
  const removedBase = removedLine.spans.find((span: any) => span.text.includes("Name"))
  const addedWord = addedLine.spans.find((span: any) => span.text === "new")
  const addedBase = addedLine.spans.find((span: any) => span.text.includes("Name"))

  if (!removedWord || !removedBase || !addedWord || !addedBase) {
    throw new Error("Expected split word/background spans for inline highlights")
  }

  const distance = (a: Float32Array, b: Float32Array) => {
    const dr = a[0]! - b[0]!
    const dg = a[1]! - b[1]!
    const db = a[2]! - b[2]!
    return Math.sqrt(dr * dr + dg * dg + db * db)
  }

  return {
    removed: distance(removedWord.bg.buffer, removedBase.bg.buffer),
    added: distance(addedWord.bg.buffer, addedBase.bg.buffer),
  }
}

// Suppress React act() warnings for opentui component tests.
// opentui's internal rendering triggers state updates outside act() boundaries,
// which is expected behavior for TUI component testing.
// testRender sets IS_REACT_ACT_ENVIRONMENT=true, so we must disable it after.
async function setupTest(jsx: React.ReactNode, opts: { width: number; height: number }) {
  const setup = await testRender(jsx, opts)
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  return setup
}

async function renderSeveralTimes(testSetup: Awaited<ReturnType<typeof testRender>>, times: number) {
  for (let index = 0; index < times; index++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    await testSetup.renderOnce()
  }
}

describe("DiffView", () => {
  let testSetup: Awaited<ReturnType<typeof testRender>>

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
    useAppStore.setState({ themeName: "github" })
  })

  it("uses transparent background for context lines when transparentBackground is enabled", async () => {
    testSetup = await setupTest(
      <DiffView
        diff={sampleDiff}
        view="unified"
        filetype="txt"
        themeName="github"
        transparentBackground
      />,
      {
        width: 80,
        height: 8,
      },
    )

    await testSetup.renderOnce()

    const frame = testSetup.captureSpans()
    const contextLine = getLineWithToken(frame, "keep")
    const contextSpan = contextLine!.spans.find((span: any) => span.text === "keep")
    expect(contextSpan).toBeDefined()
    const bg = Array.from(contextSpan!.bg.buffer)
    expect(bg[3]).toBeCloseTo(0, 4)
  })

  it("updates diff background colors after theme switch", async () => {
    useAppStore.setState({ themeName: "github" })

    testSetup = await setupTest(<ThemeToggleHarness />, {
      width: 80,
      height: 8,
    })

    await testSetup.renderOnce()

    const before = extractDiffBackgroundSample(testSetup.captureSpans())
    expect(before).toMatchInlineSnapshot(`
      {
        "contextBg": [
          0,
          0,
          0,
          1,
        ],
        "removedContentBg": [
          0.21176470816135406,
          0.11764705926179886,
          0.11764705926179886,
          1,
        ],
        "removedLineNumberBg": [
          0.10980392247438431,
          0.05098039284348488,
          0.054901961237192154,
          1,
        ],
      }
    `)

    useAppStore.setState({ themeName: "tokyonight" })
    await new Promise((r) => setTimeout(r, 10))
    await testSetup.renderOnce()

    const after = extractDiffBackgroundSample(testSetup.captureSpans())
    expect(after).toMatchInlineSnapshot(`
      {
        "contextBg": [
          0.11764705926179886,
          0.125490203499794,
          0.1882352977991104,
          1,
        ],
        "removedContentBg": [
          0.5176470875740051,
          0.32156863808631897,
          0.4156862795352936,
          1,
        ],
        "removedLineNumberBg": [
          0.1764705926179886,
          0.12156862765550613,
          0.14901961386203766,
          1,
        ],
      }
    `)

    expect(after).not.toEqual(before)
  })

  it("keeps word highlights visible on github dark theme", async () => {
    testSetup = await setupTest(
      <DiffView
        diff={wordHighlightDiff}
        view="unified"
        filetype="ts"
        themeName="github"
      />,
      {
        width: 80,
        height: 8,
      },
    )

    await testSetup.renderOnce()

    const highlights = getWordHighlightDistance(testSetup.captureSpans())
    expect(highlights.removed).toBeGreaterThan(0.03)
    expect(highlights.added).toBeGreaterThan(0.03)
  })

  it("keeps word highlights visible on near-black themes", async () => {
    testSetup = await setupTest(
      <DiffView
        diff={wordHighlightDiff}
        view="unified"
        filetype="ts"
        themeName="lucent-orng"
      />,
      {
        width: 80,
        height: 8,
      },
    )

    await testSetup.renderOnce()

    const highlights = getWordHighlightDistance(testSetup.captureSpans())
    expect(highlights.removed).toBeGreaterThan(0.01)
    expect(highlights.added).toBeGreaterThan(0.01)
  })

  it("preserves syntax highlighting for hunks that start inside a template literal", async () => {
    testSetup = await setupTest(
      <DiffView
        diff={databaseRegressionDiff}
        view="unified"
        filetype="typescript"
        themeName="github"
      />,
      {
        width: 220,
        height: 120,
      },
    )

    await renderSeveralTimes(testSetup, 5)

    const frame = testSetup.captureSpans()
    const importLine = getLineWithToken(frame, 'import dedent from "string-dedent"')
    const endpointLine = getLineWithToken(frame, 'const endpoint = existingDb.tinybirdEndpoint')

    expect(importLine?.spans.map((span: any) => span.text).filter((text: string) => text.trim() !== "")).toEqual(
      expect.arrayContaining(["import", "dedent", "from", '"string-dedent"']),
    )
    expect(endpointLine?.spans.map((span: any) => span.text).filter((text: string) => text.trim() !== "")).toEqual(
      expect.arrayContaining(["const", "endpoint", "=", '"unknown"']),
    )
  })

  it("highlights the cursor line when focused", async () => {
    testSetup = await setupTest(
      <DiffView
        diff={sampleDiff}
        view="unified"
        filetype="txt"
        themeName="github"
        focused
        cursorLine={2}
        cursorColor="#123456"
      />,
      {
        width: 80,
        height: 8,
      },
    )

    await testSetup.renderOnce()

    const frame = testSetup.captureSpans()
    // Logical line order for sampleDiff: 0 hunk-header, 1 removed "old", 2 added "new", 3 context "keep"
    const addedLine = frame.lines[2]
    expect(addedLine).toBeDefined()
    const cursorBg = Array.from(addedLine!.spans[0]!.bg.buffer)
    expect(cursorBg.slice(0, 3)).toEqual([
      expect.closeTo(18 / 255, 4),
      expect.closeTo(52 / 255, 4),
      expect.closeTo(86 / 255, 4),
    ])
  })

  it("restores the diff background color when the cursor moves past a line", async () => {
    let setCursorLine: (line: number) => void = () => {}

    function CursorMoveHarness() {
      const [line, setLine] = React.useState(2)
      setCursorLine = setLine
      return (
        <DiffView
          diff={sampleDiff}
          view="unified"
          filetype="txt"
          themeName="github"
          focused
          cursorLine={line}
          cursorColor="#123456"
        />
      )
    }

    testSetup = await setupTest(<CursorMoveHarness />, {
      width: 80,
      height: 8,
    })

    await testSetup.renderOnce()

    // Capture the original context background before the cursor moves over it.
    const frameBefore = testSetup.captureSpans()
    const contextLineBefore = getLineWithToken(frameBefore, "keep")
    expect(contextLineBefore).toBeDefined()
    const contextBg = Array.from(contextLineBefore!.spans[0]!.bg.buffer).slice(0, 3)

    // Move the cursor from the added line to the context line.
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    act(() => setCursorLine(3))
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    await testSetup.renderOnce()

    const frameAfter = testSetup.captureSpans()
    const addedLine = getLineWithToken(frameAfter, "new")
    const removedLine = getLineWithToken(frameAfter, "old")
    expect(addedLine).toBeDefined()
    expect(removedLine).toBeDefined()

    const addedSpan = addedLine!.spans.find((span: any) => span.text === "new")
    const removedSpan = removedLine!.spans.find((span: any) => span.text === "old")
    expect(addedSpan).toBeDefined()
    expect(removedSpan).toBeDefined()

    const addedBg = Array.from(addedSpan!.bg.buffer).slice(0, 3)
    const removedBg = Array.from(removedSpan!.bg.buffer).slice(0, 3)

    // After moving the cursor, the added and removed lines should show their
    // original diff backgrounds, not the default context background.
    expect(addedBg).not.toEqual(contextBg)
    expect(removedBg).not.toEqual(contextBg)
    // They should also be different from each other (added vs removed).
    expect(addedBg).not.toEqual(removedBg)
  })

  it("does not highlight a cursor line when not focused", async () => {
    testSetup = await setupTest(
      <DiffView
        diff={sampleDiff}
        view="unified"
        filetype="txt"
        themeName="github"
        focused={false}
        cursorLine={2}
        cursorColor="#123456"
      />,
      {
        width: 80,
        height: 8,
      },
    )

    await testSetup.renderOnce()

    const frame = testSetup.captureSpans()
    const addedLine = frame.lines[2]
    expect(addedLine).toBeDefined()
    const cursorBg = Array.from(addedLine!.spans[0]!.bg.buffer)
    expect(cursorBg.slice(0, 3)).not.toEqual([
      expect.closeTo(18 / 255, 4),
      expect.closeTo(52 / 255, 4),
      expect.closeTo(86 / 255, 4),
    ])
  })
})
