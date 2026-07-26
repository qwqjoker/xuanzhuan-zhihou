/// <reference lib="webworker" />

import {
  BeadConfig,
  Color,
  Puzzle,
  Rotation,
  countInternalPanels,
  distinctRotationPatterns,
  generateAutomaticPuzzle,
  internalPanelKeys,
  isIndependentPuzzleSolution,
  isLocallyMinimalPuzzleSolution,
  minimizePuzzleWalls,
} from "./maze";

type GenerateRequest = {
  type: "generate";
  size: number;
  beads: BeadConfig[];
  order: Color[];
  turnCount: number;
  rotations: Rotation[];
  optimizePanels: boolean;
};

type WorkerResponse =
  | { type: "progress"; message: string }
  | { type: "result"; puzzles: Puzzle[] };

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<GenerateRequest>) => {
  const request = event.data;
  if (request.type !== "generate") return;

  const send = (message: WorkerResponse) => scope.postMessage(message);
  send({ type: "progress", message: "正在按五珠顺序搜索共享、分叉的规则迷宫…" });
  const puzzles: Puzzle[] = [];
  const optimize = (puzzle: Puzzle) => {
    const minimized = minimizePuzzleWalls(puzzle, request.optimizePanels ? 7 : 2);
    return { ...minimized, panelCount: countInternalPanels(minimized.referenceWalls) };
  };
  const accept = (puzzle: Puzzle | null) => {
    if (!puzzle) return false;
    const minimized = optimize(puzzle);
    if (!isLocallyMinimalPuzzleSolution(minimized)) return false;
    if (!isIndependentPuzzleSolution(minimized, puzzles)) return false;
    puzzles.push(minimized);
    return true;
  };

  const primary = generateAutomaticPuzzle(
    request.size,
    request.beads,
    request.order,
    request.turnCount,
    request.beads.length >= 4 ? 800 : 500,
    0,
    request.rotations,
  );
  accept(primary);

  // A user-selected direction sequence is tried first and kept when it works.
  // If that exact sequence is incompatible with the selected starts/order,
  // keep the 10-turn limit but search the remaining CW/CCW arrangements.
  if (puzzles.length === 0) {
    send({ type: "progress", message: `当前顺逆组合无完整解，正在保持 ${request.turnCount} 次上限并自动改排旋转方向…` });
    const automaticOffsets = [0, 109, 41, 17, 73, 7, 23, 59, 89, 131, 173, 211];
    for (let index = 0; index < automaticOffsets.length && puzzles.length === 0; index += 1) {
      accept(generateAutomaticPuzzle(
        request.size,
        request.beads,
        request.order,
        request.turnCount,
        request.beads.length >= 4 ? (index === 0 ? 1600 : 1000) : 500,
        automaticOffsets[index],
      ));
    }
  }

  if (puzzles.length > 0) {
    send({ type: "progress", message: "第一套解已通过，正在改换旋转节奏并搜索不同掉落轮次…" });
    const startSupports = new Set(
      request.beads.map((bead) => `h-${bead.start.r + 1}-${bead.start.c}`),
    );
    const primaryEdges = internalPanelKeys(puzzles[0].referenceWalls)
      .filter((edge) => !startSupports.has(edge));
    const plannedSignature = request.rotations.join("|");
    const rotationPatterns = distinctRotationPatterns(
      request.beads[0].exit.direction,
      request.turnCount,
      request.beads.length,
      24,
    )
      .filter((pattern) => pattern.join("|") !== plannedSignature)
      .sort((a, b) => {
        const distance = (pattern: Rotation[]) => pattern.reduce(
          (total, rotation, index) => total + (rotation === request.rotations[index] ? 0 : 1),
          Math.abs(pattern.length - request.rotations.length),
        );
        return distance(a) - distance(b);
      });
    const productivePatterns: Rotation[][] = [];

    // First sample one forced route change per rotation pattern. This quickly
    // finds a genuinely different timing family without exhausting every wall.
    for (let index = 0; index < rotationPatterns.length && puzzles.length < 3; index += 1) {
      if (primaryEdges.length === 0) break;
      const pattern = rotationPatterns[index];
      const candidate = generateAutomaticPuzzle(
        request.size,
        request.beads,
        request.order,
        request.turnCount,
        request.beads.length >= 4 ? 1000 : 500,
        101 + index * 19,
        pattern,
        [primaryEdges[0]],
        puzzles[0].referenceWalls,
      );
      if (accept(candidate)) {
        productivePatterns.push(pattern);
        send({ type: "progress", message: `已找到第 ${puzzles.length} 套独立解，掉落轮次与已有方案不同…` });
      }
    }

    // Once a timing family works, force other route walls out to obtain more
    // independently minimized schedules before trying less promising patterns.
    const remainingPatterns = [
      ...productivePatterns,
      ...rotationPatterns.filter((pattern) => !productivePatterns.includes(pattern)),
    ];
    for (let patternIndex = 0; patternIndex < remainingPatterns.length && puzzles.length < 3; patternIndex += 1) {
      for (let edgeIndex = 1; edgeIndex < primaryEdges.length && puzzles.length < 3; edgeIndex += 1) {
        const candidate = generateAutomaticPuzzle(
          request.size,
          request.beads,
          request.order,
          request.turnCount,
          request.beads.length >= 4 ? 1200 : 600,
          401 + patternIndex * 97 + edgeIndex * 29,
          remainingPatterns[patternIndex],
          [primaryEdges[edgeIndex]],
          puzzles[0].referenceWalls,
        );
        if (accept(candidate)) {
          send({ type: "progress", message: `已找到第 ${puzzles.length} 套独立解，正在完成最终校验…` });
        }
      }
    }
  }
  puzzles.sort((a, b) =>
    (a.panelCount ?? countInternalPanels(a.referenceWalls))
      - (b.panelCount ?? countInternalPanels(b.referenceWalls)),
  );
  send({ type: "result", puzzles });
};

export {};
