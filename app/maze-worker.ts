/// <reference lib="webworker" />

import {
  BeadConfig,
  Color,
  Puzzle,
  Rotation,
  WallGrid,
  countInternalPanels,
  distinctRotationPatterns,
  generateAutomaticPuzzle,
  internalPanelKeys,
  isIndependentPuzzleSolution,
  isLocallyMinimalPuzzleSolution,
  minimizePuzzleRounds,
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
  presetWalls: WallGrid;
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
  send({ type: "progress", message: "正在按五珠顺序搜索共享、分叉的规则迷宫…" });
  const puzzles: Puzzle[] = [];
  const candidateSignatures = new Set<string>();
  const panelCandidateTarget = request.optimizePanels ? 6 : 3;
  const requiredWallKeys = internalPanelKeys(request.presetWalls);
  const optimize = (puzzle: Puzzle) => {
    const roundMinimized = minimizePuzzleRounds(
      puzzle,
      Math.min(request.turnCount, puzzle.turnCount),
    );
    const panelMinimized = minimizePuzzleWalls(
      roundMinimized,
      request.optimizePanels ? 12 : 4,
    );
    const verified = minimizePuzzleRounds(panelMinimized, roundMinimized.turnCount);
    return { ...verified, panelCount: countInternalPanels(verified.referenceWalls) };
  };
  const accept = (puzzle: Puzzle | null) => {
    if (!puzzle) return false;
    const minimized = optimize(puzzle);
    if (!isLocallyMinimalPuzzleSolution(minimized)) return false;
    const signature = internalPanelKeys(minimized.referenceWalls).sort().join("|");
    if (candidateSignatures.has(signature)) return false;
    candidateSignatures.add(signature);
    puzzles.push(minimized);
    return true;
  };

  const exitDirection = request.beads[0].exit.direction;
  const earliestExitRound = exitDirection === "left" || exitDirection === "right" ? 1 : 2;
  const synthesisTurns = earliestExitRound + Math.max(0, request.beads.length - 1) * 2;
  const automaticOffsets = [0, 109, 41, 17];
  const plannedWindow = (planningHorizon: number) => Array.from(
    { length: planningHorizon },
    (_, index) => request.rotations[index]
      ?? request.rotations[index % Math.max(1, request.rotations.length)]
      ?? "cw",
  );
  const generatePlanned = (
    planningHorizon: number,
    completionTurnLimit: number,
    attempts = request.beads.length >= 4 ? 800 : 500,
  ) =>
    generateAutomaticPuzzle(
      request.size,
      request.beads,
      request.order,
      planningHorizon,
      attempts,
      0,
      plannedWindow(planningHorizon),
      [],
      undefined,
      completionTurnLimit,
      requiredWallKeys,
    );
  const generateAutomatic = (
    planningHorizon: number,
    completionTurnLimit: number,
    offset: number,
    index: number,
    attempts = request.beads.length >= 4 ? (index === 0 ? 1200 : 800) : 500,
  ) => generateAutomaticPuzzle(
    request.size,
    request.beads,
    request.order,
    planningHorizon,
    attempts,
    offset,
    undefined,
    [],
    undefined,
    completionTurnLimit,
    requiredWallKeys,
  );
  const preview = (puzzle: Puzzle, message: string) => {
    const roundMinimized = minimizePuzzleRounds(
      puzzle,
      Math.min(request.turnCount, puzzle.turnCount),
    );
    const quicklyReduced = minimizePuzzleWalls(roundMinimized, 1);
    send({
      type: "partial",
      puzzles: [{
        ...quicklyReduced,
        panelCount: countInternalPanels(quicklyReduced.referenceWalls),
      }],
      message,
    });
  };

  // Stage 1: return one verified answer quickly. The longer searches for fewer
  // rounds, fewer panels and independent alternatives happen only after the
  // user already has a playable board.
  const horizonCeiling = Math.max(synthesisTurns, request.turnCount);
  const planningHorizons: number[] = [];
  for (let horizon = synthesisTurns; horizon <= horizonCeiling; horizon += 2) {
    planningHorizons.push(horizon);
  }
  let firstCorrectPuzzle: Puzzle | null = null;
  send({ type: "progress", message: "先快速寻找一套可播放的完整正解…" });
  for (const horizon of planningHorizons) {
    firstCorrectPuzzle = generatePlanned(horizon, request.turnCount);
    if (firstCorrectPuzzle) break;
  }
  for (let index = 0; index < automaticOffsets.length && !firstCorrectPuzzle; index += 1) {
    for (const horizon of planningHorizons) {
      firstCorrectPuzzle = generateAutomatic(
        horizon,
        request.turnCount,
        automaticOffsets[index],
        index,
      );
      if (firstCorrectPuzzle) break;
    }
  }
  if (firstCorrectPuzzle) {
    firstCorrectPuzzle = minimizePuzzleRounds(
      firstCorrectPuzzle,
      Math.min(request.turnCount, firstCorrectPuzzle.turnCount),
    );
    preview(
      firstCorrectPuzzle,
      `已找到并显示 ${firstCorrectPuzzle.turnCount} 轮正解；后台继续检查能否用更少轮完成…`,
    );
  }

  // Stage 2: with a valid upper bound in hand, test shorter completion lengths
  // in ascending order. The first verified hit is the minimum found length.
  if (firstCorrectPuzzle) {
    for (
      let targetTurns = earliestExitRound;
      targetTurns < firstCorrectPuzzle.turnCount;
      targetTurns += 2
    ) {
      send({
        type: "progress",
        message: `已有正解；正在验证能否压缩到 ${targetTurns} 轮…`,
      });
      const planningHorizon = Math.max(targetTurns, synthesisTurns);
      let shorter = generatePlanned(planningHorizon, targetTurns, 500);
      for (let index = 0; index < 3 && !shorter; index += 1) {
        shorter = generateAutomatic(
          planningHorizon,
          targetTurns,
          automaticOffsets[index],
          index,
          400,
        );
      }
      if (shorter) {
        firstCorrectPuzzle = minimizePuzzleRounds(shorter, targetTurns);
        preview(
          shorter,
          `已把正解压缩到 ${shorter.turnCount} 轮；后台开始比较同轮插板数…`,
        );
        break;
      }
    }
  }

  // Stage 3: only after correctness and completion length are settled may wall
  // minimization and independent-solution comparisons participate in ranking.
  if (firstCorrectPuzzle) accept(firstCorrectPuzzle);

  if (puzzles.length > 0) {
    const shortestTurns = Math.min(...puzzles.map((puzzle) => puzzle.turnCount));
    const solutionPlanningHorizon = Math.max(shortestTurns, synthesisTurns);
    send({
      type: "progress",
      message: `最少轮搜索完成；正在同为 ${shortestTurns} 轮的正解中减少插板并搜索独立解…`,
    });
    const startSupports = new Set(
      request.beads.map((bead) => `h-${bead.start.r + 1}-${bead.start.c}`),
    );
    const primaryEdges = internalPanelKeys(puzzles[0].referenceWalls)
      .filter((edge) => !startSupports.has(edge));
    const plannedSignature = request.rotations.join("|");
    const rotationPatterns = distinctRotationPatterns(
      request.beads[0].exit.direction,
      solutionPlanningHorizon,
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
    const panelSearchBudget = request.optimizePanels ? 14 : 6;
    let panelSearchAttempts = 0;

    // Collect several same-round valid candidates before ranking by panel
    // count. A candidate is kept even when it shares a drop schedule with an
    // earlier one, because it may use fewer panels.
    for (
      let index = 0;
      index < Math.min(rotationPatterns.length, 12)
        && puzzles.length < panelCandidateTarget
        && panelSearchAttempts < panelSearchBudget;
      index += 1
    ) {
      if (primaryEdges.length === 0) break;
      panelSearchAttempts += 1;
      const pattern = rotationPatterns[index];
      const candidate = generateAutomaticPuzzle(
        request.size,
        request.beads,
        request.order,
        solutionPlanningHorizon,
        request.beads.length >= 4 ? 1000 : 500,
        101 + index * 19,
        pattern,
        [primaryEdges[0]],
        puzzles[0].referenceWalls,
        shortestTurns,
        requiredWallKeys,
      );
      if (accept(candidate)) {
        productivePatterns.push(pattern);
        send({ type: "progress", message: `已比较 ${puzzles.length} 套同轮正解；当前最少 ${Math.min(...puzzles.map((item) => item.panelCount ?? Infinity))} 片插板…` });
      }
    }

    // Once a timing family works, force other route walls out to obtain more
    // independently minimized schedules before trying less promising patterns.
    const remainingPatterns = [
      ...productivePatterns,
      ...rotationPatterns.filter((pattern) => !productivePatterns.includes(pattern)),
    ];
    for (
      let patternIndex = 0;
      patternIndex < remainingPatterns.length
        && puzzles.length < panelCandidateTarget
        && panelSearchAttempts < panelSearchBudget;
      patternIndex += 1
    ) {
      for (
        let edgeIndex = 1;
        edgeIndex < primaryEdges.length
          && puzzles.length < panelCandidateTarget
          && panelSearchAttempts < panelSearchBudget;
        edgeIndex += 1
      ) {
        panelSearchAttempts += 1;
        const candidate = generateAutomaticPuzzle(
          request.size,
          request.beads,
          request.order,
          solutionPlanningHorizon,
          request.beads.length >= 4 ? 1200 : 600,
          401 + patternIndex * 97 + edgeIndex * 29,
          remainingPatterns[patternIndex],
          [primaryEdges[edgeIndex]],
          puzzles[0].referenceWalls,
          shortestTurns,
          requiredWallKeys,
        );
        if (accept(candidate)) {
          send({ type: "progress", message: `已比较 ${puzzles.length} 套同轮正解；当前最少 ${Math.min(...puzzles.map((item) => item.panelCount ?? Infinity))} 片插板…` });
        }
      }
    }
  }
  puzzles.sort((a, b) =>
    a.turnCount - b.turnCount
    || (a.panelCount ?? countInternalPanels(a.referenceWalls))
      - (b.panelCount ?? countInternalPanels(b.referenceWalls)),
  );
  const shortest = puzzles[0]?.turnCount;
  const shortestCandidates = shortest === undefined
    ? []
    : puzzles.filter((puzzle) => puzzle.turnCount === shortest);
  const ranked: Puzzle[] = [];
  for (const candidate of shortestCandidates) {
    if (ranked.length === 0 || isIndependentPuzzleSolution(candidate, ranked)) {
      ranked.push(candidate);
    }
    if (ranked.length >= 3) break;
  }
  send({
    type: "result",
    puzzles: ranked,
  });
};

export {};
