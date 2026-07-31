/// <reference lib="webworker" />

import {
  BeadConfig,
  Color,
  Puzzle,
  Rotation,
  WallGrid,
  countInternalPanels,
  generateAutomaticPuzzle,
  internalPanelKeys,
  isIndependentPuzzleSolution,
  isLocallyMinimalPuzzleSolution,
  minimizePuzzleWalls,
  puzzleFromSolvedWalls,
  puzzleCompletionRound,
} from "./maze";

type GenerateRequest = {
  type: "generate";
  size: number;
  beads: BeadConfig[];
  order: Color[];
  turnCount: number;
  rotations: Rotation[];
  optimizePanels: boolean;
  presetWalls: WallGrid;
  seedWalls?: WallGrid[];
};

type WorkerResponse =
  | { type: "progress"; message: string }
  | { type: "partial"; puzzles: Puzzle[]; message: string }
  | { type: "result"; puzzles: Puzzle[] };

const scope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<GenerateRequest>) => {
  const request = event.data;
  if (request.type !== "generate") return;

  const send = (message: WorkerResponse) => scope.postMessage(message);
  send({ type: "progress", message: "正在按固定旋转序列寻找完整正解…" });

  const puzzles: Puzzle[] = [];
  const candidateSignatures = new Set<string>();
  const requiredWallKeys = internalPanelKeys(request.presetWalls);
  const candidateTarget = request.optimizePanels ? 4 : 3;
  const variantOffsets = [0, 109, 41, 17, 233, 317, 503, 701];
  const prescribedRotations = Array.from(
    { length: request.turnCount },
    (_, index) => request.rotations[index]
      ?? request.rotations[index % Math.max(1, request.rotations.length)]
      ?? "cw",
  );

  const publishable = (puzzle: Puzzle): Puzzle => ({
    ...puzzle,
    turnCount: request.turnCount,
    completionRound: puzzleCompletionRound(puzzle),
    rotations: [...prescribedRotations],
    panelCount: countInternalPanels(puzzle.referenceWalls),
  });

  const optimize = (puzzle: Puzzle, trials = request.optimizePanels ? 12 : 4) => {
    const normalized = publishable(puzzle);
    return publishable(minimizePuzzleWalls(normalized, trials));
  };

  const accept = (puzzle: Puzzle | null) => {
    if (!puzzle) return false;
    const completionRound = puzzleCompletionRound(puzzle);
    if (completionRound < 1 || completionRound > request.turnCount) return false;
    if (puzzle.rotations.length !== prescribedRotations.length) return false;
    if (puzzle.rotations.some((rotation, index) => rotation !== prescribedRotations[index])) return false;
    const minimized = optimize(puzzle);
    if (!isLocallyMinimalPuzzleSolution(minimized)) return false;
    const signature = internalPanelKeys(minimized.referenceWalls).sort().join("|");
    if (candidateSignatures.has(signature)) return false;
    candidateSignatures.add(signature);
    puzzles.push(minimized);
    return true;
  };

  const generate = (
    completionTurnLimit: number,
    attempts: number,
    variantOffset: number,
    forbiddenWallKeys: string[] = [],
    initialWalls?: WallGrid,
  ) => generateAutomaticPuzzle(
    request.size,
    request.beads,
    request.order,
    request.turnCount,
    attempts,
    variantOffset,
    prescribedRotations,
    forbiddenWallKeys,
    initialWalls,
    completionTurnLimit,
    requiredWallKeys,
  );

  const preview = (puzzle: Puzzle, message: string) => {
    const quicklyReduced = optimize(puzzle, 1);
    send({ type: "partial", puzzles: [quicklyReduced], message });
  };

  // A bead can only leave on a round whose board gravity points at the shared
  // outlet. These are the only completion lengths worth searching.
  const orientationGravity = ["down", "right", "up", "left"] as const;
  let orientation = 0;
  const exitOpportunityRounds: number[] = [];
  prescribedRotations.forEach((rotation, index) => {
    orientation = (orientation + (rotation === "cw" ? 1 : 3)) % 4;
    if (orientationGravity[orientation] === request.beads[0].exit.direction) {
      exitOpportunityRounds.push(index + 1);
    }
  });

  // Treat the player's current board and this question's saved answers as
  // verified upper bounds. Automatic search must never report a result that is
  // slower than a valid solution the user has already made.
  const seededPuzzles = (request.seedWalls ?? [])
    .map((seedWalls) => puzzleFromSolvedWalls(
      request.size,
      request.beads,
      request.order,
      prescribedRotations,
      seedWalls,
      request.presetWalls,
    ))
    .filter((puzzle): puzzle is Puzzle => Boolean(puzzle))
    .sort((a, b) =>
      puzzleCompletionRound(a) - puzzleCompletionRound(b)
      || countInternalPanels(a.referenceWalls) - countInternalPanels(b.referenceWalls));

  // Stage 1: find one valid solution quickly while preserving every prescribed
  // round. Later rounds remain part of the question even after all beads leave.
  let bestPuzzle: Puzzle | null = seededPuzzles[0] ?? null;
  if (bestPuzzle) {
    preview(
      bestPuzzle,
      `已采用当前题目中已验证的第 ${puzzleCompletionRound(bestPuzzle)} 轮方案作为基准，继续搜索更少轮次。`,
    );
  }
  for (let index = 0; index < variantOffsets.length && !bestPuzzle; index += 1) {
    bestPuzzle = generate(
      request.turnCount,
      request.beads.length >= 4 ? (index === 0 ? 1400 : 900) : 600,
      variantOffsets[index],
    );
  }
  if (bestPuzzle) {
    preview(
      bestPuzzle,
      `已找到完整正解：题目保留 ${request.turnCount} 轮，当前第 ${puzzleCompletionRound(bestPuzzle)} 轮完成；继续压缩完成轮次…`,
    );
  }

  // Stage 2: search completion opportunities from earliest to latest. The
  // first verified hit is the minimum completion round found for this exact
  // clockwise/counter-clockwise sequence.
  const currentCompletion = bestPuzzle ? puzzleCompletionRound(bestPuzzle) : request.turnCount + 1;
  const shorterTargets = exitOpportunityRounds.filter((round) => round < currentCompletion);
  for (const targetRound of shorterTargets) {
    send({
      type: "progress",
      message: `已有正解；正在验证是否能在第 ${targetRound} 轮全部完成…`,
    });
    let shorter: Puzzle | null = null;
    for (let index = 0; index < Math.min(4, variantOffsets.length) && !shorter; index += 1) {
      shorter = generate(
        targetRound,
        request.beads.length >= 4 ? 900 : 550,
        variantOffsets[index] + targetRound * 53,
      );
    }
    if (shorter) {
      bestPuzzle = shorter;
      preview(
        shorter,
        `已压缩到第 ${targetRound} 轮完成；题目仍保留全部 ${request.turnCount} 轮，继续比较同轮最少挡板…`,
      );
      break;
    }
  }

  // Stage 3: only after completion length is fixed do panel count and
  // independent route families participate in ranking.
  if (bestPuzzle) {
    accept(bestPuzzle);
    const bestRound = puzzleCompletionRound(bestPuzzle);
    seededPuzzles
      .filter((candidate) => puzzleCompletionRound(candidate) === bestRound)
      .forEach((candidate) => accept(candidate));
  }
  if (puzzles.length > 0) {
    const shortestRound = Math.min(...puzzles.map(puzzleCompletionRound));
    send({
      type: "progress",
      message: `最早完成轮次为第 ${shortestRound} 轮；正在减少挡板并寻找不同路径的独立解…`,
    });
    const startSupports = new Set(
      request.beads.map((bead) => `h-${bead.start.r + 1}-${bead.start.c}`),
    );
    const primaryEdges = internalPanelKeys(puzzles[0].referenceWalls)
      .filter((edge) => !startSupports.has(edge) && !requiredWallKeys.includes(edge));
    const panelSearchBudget = request.optimizePanels ? 8 : 5;
    let panelSearchAttempts = 0;

    for (
      let offsetIndex = 0;
      offsetIndex < variantOffsets.length
        && puzzles.length < candidateTarget
        && panelSearchAttempts < panelSearchBudget;
      offsetIndex += 1
    ) {
      const edgeChoices = primaryEdges.length > 0 ? primaryEdges : [""];
      for (
        let edgeIndex = 0;
        edgeIndex < edgeChoices.length
          && puzzles.length < candidateTarget
          && panelSearchAttempts < panelSearchBudget;
        edgeIndex += 1
      ) {
        panelSearchAttempts += 1;
        const forbidden = edgeChoices[edgeIndex] ? [edgeChoices[edgeIndex]] : [];
        const candidate = generate(
          shortestRound,
          request.beads.length >= 4 ? 1000 : 550,
          1009 + variantOffsets[offsetIndex] + edgeIndex * 71,
          forbidden,
          puzzles[0].referenceWalls,
        );
        if (accept(candidate)) {
          send({
            type: "progress",
            message: `已比较 ${puzzles.length} 套第 ${shortestRound} 轮完成的独立正解；当前最少 ${Math.min(...puzzles.map((item) => item.panelCount ?? Infinity))} 片挡板…`,
          });
        }
      }
    }
  }

  puzzles.sort((a, b) =>
    puzzleCompletionRound(a) - puzzleCompletionRound(b)
    || (a.panelCount ?? countInternalPanels(a.referenceWalls))
      - (b.panelCount ?? countInternalPanels(b.referenceWalls)),
  );
  const shortestRound = puzzles[0] ? puzzleCompletionRound(puzzles[0]) : undefined;
  const shortestCandidates = shortestRound === undefined
    ? []
    : puzzles.filter((puzzle) => puzzleCompletionRound(puzzle) === shortestRound);
  const ranked: Puzzle[] = [];
  for (const candidate of shortestCandidates) {
    if (ranked.length === 0 || isIndependentPuzzleSolution(candidate, ranked)) {
      ranked.push(candidate);
    }
    if (ranked.length >= 3) break;
  }
  send({ type: "result", puzzles: ranked });
};

export {};
