import parseDiff from "parse-diff"

/** Worker/getDiffBetween output format */
export interface PrChangeInput {
  path: string
  status: "added" | "modified" | "deleted" | "renamed"
  diffHunks: Array<{
    oldStart: number
    oldLines: number
    newStart: number
    newLines: number
    patches: Array<{line: string; type: "+" | "-" | " "}>
  }>
}

/** Convert PrChange (worker diffHunks format) to parse-diff File for DiffViewer */
export function prChangeToParseDiffFile(change: PrChangeInput): parseDiff.File {
  const path = change.path
  const from = change.status === "added" ? "/dev/null" : path
  const to = change.status === "deleted" ? "/dev/null" : path
  const chunks: parseDiff.Chunk[] = []
  let additions = 0
  let deletions = 0

  for (const hunk of change.diffHunks || []) {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    const changes: parseDiff.Change[] = []

    for (const patch of hunk.patches || []) {
      const content = (patch.line || "").replace(/^[\+\-]/, "") || ""
      const t = patch.type

      if (t === "+") {
        changes.push({type: "add", add: true, ln: newLine, content})
        newLine++
        additions++
      } else if (t === "-") {
        changes.push({type: "del", del: true, ln: oldLine, content})
        oldLine++
        deletions++
      } else {
        changes.push({type: "normal", normal: true, ln1: oldLine, ln2: newLine, content})
        oldLine++
        newLine++
      }
    }
    chunks.push({
      content: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      changes,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
    })
  }
  return {from, to, chunks, additions, deletions}
}
