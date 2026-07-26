export type Color = "red" | "yellow" | "blue" | "green" | "purple";
export type Direction = "up" | "right" | "down" | "left";
export type Rotation = "cw" | "ccw";
export type Cell = { r: number; c: number };
export type Exit = { cell: Cell; direction: Direction };

export type BeadConfig = {
  color: Color;
  start: Cell;
  exit: Exit;
};

export type MazePath = {
  color: Color;
  cells: Cell[];
  exit: Direction;
  opensExit?: boolean;
};

export type WallGrid = {
  h: boolean[][];
  v: boolean[][];
};

export type Puzzle = {
  rulesVersion: 3;
  size: number;
  beads: BeadConfig[];
  order: Color[];
  turnCount: number;
  minLength: number;
  maxLength: number;
  rotations: Rotation[];
  dropRounds: Partial<Record<Color, number>>;
  paths: MazePath[];
  referenceWalls: WallGrid;
  solutionLowerBound: number;
  countedSamples: number;
  panelCount?: number;
  optimizationTrials?: number;
  commonChannelLength?: number;
};

export type BallPosition = Cell | null;

export type SimulationFrame = {
  round: number;
  orientation: number;
  angle: number;
  gravity: Direction;
  positions: Partial<Record<Color, BallPosition>>;
  dropped: Color[];
  dropEvents: DropEvent[];
  blocked: Color[];
  movementOrder: Color[];
  trajectories: Partial<Record<Color, Cell[]>>;
};

export type DropEvent = {
  color: Color;
  exit: Exit;
};

export type ValidationResult = {
  ok: boolean;
  title: string;
  details: string[];
  frames?: SimulationFrame[];
};

export const ALL_COLORS: Color[] = ["red", "yellow", "blue", "green", "purple"];

export const COLOR_LABEL: Record<Color, string> = {
  red: "红",
  yellow: "黄",
  blue: "蓝",
  green: "绿",
  purple: "紫",
};

export const DIR_DELTA: Record<Direction, Cell> = {
  up: { r: -1, c: 0 },
  right: { r: 0, c: 1 },
  down: { r: 1, c: 0 },
  left: { r: 0, c: -1 },
};

const ORIENTATION_GRAVITY: Direction[] = ["down", "right", "up", "left"];
const key = (cell: Cell) => `${cell.r},${cell.c}`;
const sameCell = (a: Cell, b: Cell) => a.r === b.r && a.c === b.c;
const inside = (cell: Cell, size: number) =>
  cell.r >= 0 && cell.r < size && cell.c >= 0 && cell.c < size;

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function seededRank(seed: number, ...values: number[]): number {
  let value = (seed + 0x9e3779b9) >>> 0;
  for (const item of values) {
    value ^= (item + 0x9e3779b9 + (value << 6) + (value >>> 2)) >>> 0;
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
    value ^= value >>> 16;
  }
  return value >>> 0;
}

export function makeBlankWalls(size: number, interiorFilled = false): WallGrid {
  return {
    h: Array.from({ length: size + 1 }, (_, r) =>
      Array.from({ length: size }, () => interiorFilled || r === 0 || r === size),
    ),
    v: Array.from({ length: size }, () =>
      Array.from({ length: size + 1 }, (_, c) =>
        interiorFilled || c === 0 || c === size,
      ),
    ),
  };
}

export function makeAnswerWalls(size: number, beads: BeadConfig[]): WallGrid {
  const walls = makeBlankWalls(size, false);
  beads.forEach((bead) => setBoundaryWall(walls, bead.exit.cell, bead.exit.direction, false));
  beads.forEach((bead) => {
    walls.h[bead.start.r + 1][bead.start.c] = true;
  });
  return walls;
}

export function cloneWalls(walls: WallGrid): WallGrid {
  return { h: walls.h.map((row) => [...row]), v: walls.v.map((row) => [...row]) };
}

export function boundaryDirections(cell: Cell, size: number): Direction[] {
  const result: Direction[] = [];
  if (cell.r === 0) result.push("up");
  if (cell.c === size - 1) result.push("right");
  if (cell.r === size - 1) result.push("down");
  if (cell.c === 0) result.push("left");
  return result;
}

function oppositeDirection(direction: Direction): Direction {
  return ({ up: "down", right: "left", down: "up", left: "right" })[direction] as Direction;
}

function perpendicularDirections(direction: Direction): Direction[] {
  return direction === "up" || direction === "down" ? ["left", "right"] : ["up", "down"];
}

export function sharedTrunkCells(exit: Exit, size: number, requestedLength = 3): Cell[] {
  const cells: Cell[] = [{ ...exit.cell }];
  const inward = oppositeDirection(exit.direction);
  const length = Math.max(2, Math.min(requestedLength, size));
  let cursor = { ...exit.cell };
  while (cells.length < length) {
    const next = {
      r: cursor.r + DIR_DELTA[inward].r,
      c: cursor.c + DIR_DELTA[inward].c,
    };
    if (!inside(next, size)) break;
    cells.unshift(next);
    cursor = next;
  }
  return cells;
}

function setWallBetween(walls: WallGrid, a: Cell, b: Cell, value: boolean) {
  if (a.r === b.r) walls.v[a.r][Math.max(a.c, b.c)] = value;
  else walls.h[Math.max(a.r, b.r)][a.c] = value;
}

function setBoundaryWall(
  walls: WallGrid,
  cell: Cell,
  direction: Direction,
  value: boolean,
) {
  const size = walls.v[0].length - 1;
  if (direction === "up") walls.h[0][cell.c] = value;
  if (direction === "down") walls.h[size][cell.c] = value;
  if (direction === "left") walls.v[cell.r][0] = value;
  if (direction === "right") walls.v[cell.r][size] = value;
}

export function pathsToWalls(size: number, paths: MazePath[]): WallGrid {
  const walls = makeBlankWalls(size, true);
  paths.forEach((path) => {
    for (let i = 1; i < path.cells.length; i += 1) {
      setWallBetween(walls, path.cells[i - 1], path.cells[i], false);
    }
    if (path.opensExit !== false) {
      setBoundaryWall(walls, path.cells[path.cells.length - 1], path.exit, false);
    }
  });
  return walls;
}

function tryRandomPath(
  bead: BeadConfig,
  blocked: Set<string>,
  size: number,
  minLength: number,
  maxLength: number,
): MazePath | null {
  const target = bead.exit.cell;
  if (blocked.has(key(bead.start)) || blocked.has(key(target))) return null;
  const path: Cell[] = [{ ...bead.start }];
  const visited = new Set<string>([key(bead.start)]);
  let budget = Math.max(12000, size * size * 180);

  const walk = (): Cell[] | null => {
    budget -= 1;
    if (budget <= 0) return null;
    const current = path[path.length - 1];
    const distance = Math.abs(current.r - target.r) + Math.abs(current.c - target.c);
    if (sameCell(current, target)) {
      return path.length >= minLength && path.length <= maxLength
        ? path.map((cell) => ({ ...cell }))
        : null;
    }
    if (path.length >= maxLength || path.length + distance > maxLength) return null;

    let options = (Object.keys(DIR_DELTA) as Direction[])
      .map((direction) => ({
        r: current.r + DIR_DELTA[direction].r,
        c: current.c + DIR_DELTA[direction].c,
      }))
      .filter(
        (cell) => inside(cell, size) &&
          !visited.has(key(cell)) &&
          !blocked.has(key(cell)) &&
          !(path.length === 1 && cell.r === bead.start.r + 1 && cell.c === bead.start.c),
      );

    options = shuffled(options).sort((a, b) => {
      const da = Math.abs(a.r - target.r) + Math.abs(a.c - target.c);
      const db = Math.abs(b.r - target.r) + Math.abs(b.c - target.c);
      const needDetour = path.length + distance < minLength;
      return needDetour ? db - da : da - db;
    });

    for (const next of options) {
      if (sameCell(next, target) && path.length + 1 < minLength) continue;
      path.push(next);
      visited.add(key(next));
      const result = walk();
      if (result) return result;
      visited.delete(key(next));
      path.pop();
    }
    return null;
  };

  const cells = walk();
  return cells ? { color: bead.color, cells, exit: bead.exit.direction } : null;
}

function randomSharedPathSet(
  beads: BeadConfig[],
  size: number,
  minLength: number,
  maxLength: number,
): MazePath[] | null {
  const allowSharedBaseCells = beads.length >= 4;
  for (let outer = 0; outer < 90; outer += 1) {
    const blocked = new Set<string>();
    const paths = new Map<Color, MazePath>();
    let failed = false;
    for (let orderIndex = 0; orderIndex < beads.length; orderIndex += 1) {
      const bead = beads[orderIndex];
      const unavailable = new Set(allowSharedBaseCells ? [] : blocked);
      beads
        .filter((other) => other.color !== bead.color)
        .forEach((other) => {
          unavailable.add(key(other.start));
          if (!sameCell(other.exit.cell, bead.exit.cell)) unavailable.add(key(other.exit.cell));
        });
      unavailable.delete(key(bead.exit.cell));
      let path: MazePath | null = null;
      for (let attempt = 0; attempt < 18 && !path; attempt += 1) {
        const directLength = Math.abs(bead.start.r - bead.exit.cell.r) + Math.abs(bead.start.c - bead.exit.cell.c) + 1;
        const routeMin = Math.min(
          maxLength,
          allowSharedBaseCells
            ? directLength + (Math.random() < 0.25 ? 2 : 0)
            : directLength + 2 + (Math.random() < 0.35 ? 2 : 0),
        );
        path = tryRandomPath(bead, unavailable, size, routeMin, maxLength);
      }
      if (!path) {
        failed = true;
        break;
      }
      paths.set(bead.color, path);
      path.cells.forEach((cell) => blocked.add(key(cell)));
    }
    if (failed) continue;

    const orderedPaths = beads.map((bead) => paths.get(bead.color)!);
    const connectors: MazePath[] = [];
    const connectedCells = [...orderedPaths[0].cells];
    for (const path of orderedPaths.slice(1)) {
      const fromCandidates = connectedCells.slice(1, -1);
      const toCandidates = path.cells.slice(1, -1);
      if (fromCandidates.length === 0 || toCandidates.length === 0) {
        failed = true;
        break;
      }
      let bestFrom = fromCandidates[0];
      let bestTo = toCandidates[0];
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const from of shuffled(fromCandidates)) {
        for (const to of shuffled(toCandidates)) {
          const distance = Math.abs(from.r - to.r) + Math.abs(from.c - to.c);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestFrom = from;
            bestTo = to;
          }
        }
      }

      const cells: Cell[] = [{ ...bestFrom }];
      let cursor = { ...bestFrom };
      const moveRows = () => {
        while (cursor.r !== bestTo.r) {
          cursor = { r: cursor.r + Math.sign(bestTo.r - cursor.r), c: cursor.c };
          cells.push(cursor);
        }
      };
      const moveColumns = () => {
        while (cursor.c !== bestTo.c) {
          cursor = { r: cursor.r, c: cursor.c + Math.sign(bestTo.c - cursor.c) };
          cells.push(cursor);
        }
      };
      if (Math.random() < 0.5) { moveColumns(); moveRows(); }
      else { moveRows(); moveColumns(); }
      connectors.push({ color: orderedPaths[0].color, cells, exit: "up", opensExit: false });
      connectedCells.push(...path.cells, ...cells);
    }
    if (failed) continue;

    const sharedPaths = [...orderedPaths, ...connectors];
    const walls = pathsToWalls(size, sharedPaths);
    const network = networkStats(walls, beads[0].start);
    const allTerminalsConnected = beads.every(
      (bead) => network.keys.has(key(bead.start)) && network.keys.has(key(bead.exit.cell)),
    );
    if (
      allTerminalsConnected &&
      network.cells.length >= minLength &&
      network.cells.length <= maxLength &&
      network.junctions > 0
    ) {
      return sharedPaths;
    }
  }
  return null;
}

function randomSharedTrackSet(
  beads: BeadConfig[],
  size: number,
  minLength: number,
  maxLength: number,
): MazePath[] | null {
  const trunk = sharedTrunkCells(beads[0].exit, size, 3);
  const trunkEntry = trunk[0];
  const protectedTrunk = new Set(trunk.slice(1).map(key));

  for (let outer = 0; outer < 80; outer += 1) {
    const paths = new Map<Color, MazePath>();
    let failed = false;
    for (let orderIndex = 0; orderIndex < beads.length; orderIndex += 1) {
      const bead = beads[orderIndex];
      // Branches may deliberately cross and merge. Treating every earlier
      // branch as blocked recreated isolated single channels and made five-ball
      // boards needlessly impossible.
      const unavailable = new Set<string>();
      protectedTrunk.forEach((cellKey) => unavailable.add(cellKey));
      beads
        .filter((other) => other.color !== bead.color)
        .forEach((other) => unavailable.add(key(other.start)));
      unavailable.delete(key(trunkEntry));

      const branchBead: BeadConfig = {
        ...bead,
        exit: { cell: { ...trunkEntry }, direction: bead.exit.direction },
      };
      let branch: MazePath | null = null;
      for (let attempt = 0; attempt < 24 && !branch; attempt += 1) {
        const directLength = Math.abs(bead.start.r - trunkEntry.r) + Math.abs(bead.start.c - trunkEntry.c) + 1;
        const orderedDetour = orderIndex * 2;
        const routeMin = Math.min(
          maxLength - trunk.length + 1,
          directLength + orderedDetour + (Math.random() < 0.35 ? 2 : 0),
        );
        branch = tryRandomPath(branchBead, unavailable, size, Math.max(2, routeMin), maxLength - trunk.length + 1);
      }
      if (!branch) { failed = true; break; }

      const cells = [...branch.cells, ...trunk.slice(1).map((cell) => ({ ...cell }))];
      const path: MazePath = { color: bead.color, cells, exit: bead.exit.direction };
      paths.set(bead.color, path);
    }
    if (failed) continue;

    const orderedPaths = beads.map((bead) => paths.get(bead.color)!);
    const walls = pathsToWalls(size, orderedPaths);
    const network = networkStats(walls, beads[0].start);
    if (
      beads.every((bead) => network.keys.has(key(bead.start)) && network.keys.has(key(bead.exit.cell)))
      && network.cells.length >= minLength
      && network.cells.length <= maxLength
      && network.junctions > 0
    ) return orderedPaths;
  }
  return null;
}

type SearchNode = {
  q: number;
  positions: Partial<Record<Color, BallPosition>>;
  progress: number;
  rotations: Rotation[];
  dropRounds: Partial<Record<Color, number>>;
};

function searchRotationSequence(
  walls: WallGrid,
  beads: BeadConfig[],
  order: Color[],
  turnCount: number,
  targetRounds: Partial<Record<Color, number>>,
): { rotations: Rotation[]; dropRounds: Partial<Record<Color, number>> } | null {
  const targetByRound = new Map<number, Color>();
  let previousTarget = 0;
  for (const color of order) {
    const target = targetRounds[color];
    if (!Number.isInteger(target) || !target || target <= previousTarget || target > turnCount) return null;
    targetByRound.set(target, color);
    previousTarget = target;
  }
  if (previousTarget !== turnCount) return null;

  const initialPositions: Partial<Record<Color, BallPosition>> = {};
  beads.forEach((bead) => { initialPositions[bead.color] = { ...bead.start }; });
  let frontier: SearchNode[] = [
    { q: 0, positions: initialPositions, progress: 0, rotations: [], dropRounds: {} },
  ];

  for (let round = 1; round <= turnCount; round += 1) {
    const nextFrontier: SearchNode[] = [];
    const seen = new Set<string>();
    const targetColor = targetByRound.get(round);
    for (const node of frontier) {
      for (const rotation of ["cw", "ccw"] as Rotation[]) {
        const q = (node.q + (rotation === "cw" ? 1 : 3)) % 4;
        const gravity = ORIENTATION_GRAVITY[q];
        const tilt = tiltBalls(walls, beads, node.positions, gravity);
        if (tilt.dropEvents.length > 1) continue;
        if (tilt.dropEvents.some((event) => {
          const expected = beads.find((bead) => bead.color === event.color)!.exit;
          return !sameCell(event.exit.cell, expected.cell) || event.exit.direction !== expected.direction;
        })) continue;
        let progress = node.progress;
        const dropRounds = { ...node.dropRounds };
        if (tilt.dropEvents.length === 1) {
          const color = tilt.dropEvents[0].color;
          if (!targetColor || color !== targetColor || color !== order[progress]) continue;
          progress += 1;
          dropRounds[color] = round;
        } else if (targetColor) {
          continue;
        }
        if (round === turnCount) {
          if (progress === order.length) {
            return { rotations: [...node.rotations, rotation], dropRounds };
          }
          continue;
        }
        const positionsKey = beads.map((bead) => {
          const position = tilt.positions[bead.color];
          return position ? key(position) : "x";
        }).join(";");
        const stateKey = `${q}|${positionsKey}|${progress}`;
        if (seen.has(stateKey)) continue;
        seen.add(stateKey);
        nextFrontier.push({
          q,
          positions: tilt.positions,
          progress,
          rotations: [...node.rotations, rotation],
          dropRounds,
        });
      }
    }
    frontier = nextFrontier.slice(0, 26000);
    if (frontier.length === 0) {
      return null;
    }
  }
  return null;
}

function searchAutomaticRotationSequence(
  walls: WallGrid,
  beads: BeadConfig[],
  order: Color[],
  maximumTurns: number,
): { rotations: Rotation[]; dropRounds: Partial<Record<Color, number>> } | null {
  const initialPositions: Partial<Record<Color, BallPosition>> = {};
  beads.forEach((bead) => { initialPositions[bead.color] = { ...bead.start }; });
  let frontier: SearchNode[] = [
    { q: 0, positions: initialPositions, progress: 0, rotations: [], dropRounds: {} },
  ];

  for (let round = 1; round <= maximumTurns; round += 1) {
    const nextFrontier: SearchNode[] = [];
    const seen = new Set<string>();
    for (const node of frontier) {
      for (const rotation of ["cw", "ccw"] as Rotation[]) {
        const q = (node.q + (rotation === "cw" ? 1 : 3)) % 4;
        const gravity = ORIENTATION_GRAVITY[q];
        const tilt = tiltBalls(walls, beads, node.positions, gravity);
        if (tilt.dropEvents.length > 1) continue;
        if (tilt.dropEvents.some((event) => {
          const expected = beads.find((bead) => bead.color === event.color)!.exit;
          return !sameCell(event.exit.cell, expected.cell) || event.exit.direction !== expected.direction;
        })) continue;

        let progress = node.progress;
        const dropRounds = { ...node.dropRounds };
        if (tilt.dropEvents.length === 1) {
          const color = tilt.dropEvents[0].color;
          if (color !== order[progress]) continue;
          dropRounds[color] = round;
          progress += 1;
          if (progress === order.length) {
            return { rotations: [...node.rotations, rotation], dropRounds };
          }
        }

        const positionsKey = beads.map((bead) => {
          const position = tilt.positions[bead.color];
          return position ? key(position) : "x";
        }).join(";");
        const stateKey = `${q}|${positionsKey}|${progress}`;
        if (seen.has(stateKey)) continue;
        seen.add(stateKey);
        nextFrontier.push({
          q,
          positions: tilt.positions,
          progress,
          rotations: [...node.rotations, rotation],
          dropRounds,
        });
      }
    }
    nextFrontier.sort((a, b) => {
      if (a.progress !== b.progress) return b.progress - a.progress;
      const nextColor = order[a.progress];
      const bead = beads.find((item) => item.color === nextColor);
      if (!bead) return 0;
      const distance = (node: SearchNode) => {
        const position = node.positions[nextColor];
        return position
          ? Math.abs(position.r - bead.exit.cell.r) + Math.abs(position.c - bead.exit.cell.c)
          : -1;
      };
      return distance(a) - distance(b);
    });
    frontier = nextFrontier.slice(0, beads.length >= 4 ? 120 : 2400);
    if (frontier.length === 0) return null;
  }
  return null;
}

function wallSignature(walls: WallGrid): string {
  return `${walls.h.map((row) => row.map(Number).join("")).join("/")}|${walls.v.map((row) => row.map(Number).join("")).join("/")}`;
}

export function simulatePaths(paths: MazePath[], rotations: Rotation[]): SimulationFrame[] {
  const beads: BeadConfig[] = paths.map((path) => ({
    color: path.color,
    start: path.cells[0],
    exit: { cell: path.cells[path.cells.length - 1], direction: path.exit },
  }));
  return simulateWalls(pathsToWalls(
    Math.max(...paths.flatMap((path) => path.cells.flatMap((cell) => [cell.r, cell.c]))) + 1,
    paths,
  ), beads, rotations);
}

function matchesPuzzle(
  paths: MazePath[],
  size: number,
  beads: BeadConfig[],
  rotations: Rotation[],
  expectedRounds: Partial<Record<Color, number>>,
): boolean {
  const walls = pathsToWalls(size, paths);
  const frames = simulateWalls(walls, beads, rotations);
  const actual: Partial<Record<Color, number>> = {};
  for (const frame of frames) {
    if (frame.round === 0 && frame.dropped.length > 0) return false;
    if (frame.dropEvents.some((event) => {
      const expected = beads.find((bead) => bead.color === event.color)!.exit;
      return !sameCell(event.exit.cell, expected.cell) || event.exit.direction !== expected.direction;
    })) return false;
    frame.dropped.forEach((color) => { actual[color] = frame.round; });
  }
  return frames.flatMap((frame) => frame.dropped).join("|") === beads.map((bead) => bead.color).join("|")
    && beads.every((bead) => actual[bead.color] === expectedRounds[bead.color]);
}

function wallEdgeKey(cell: Cell, direction: Direction): string {
  if (direction === "up") return `h-${cell.r}-${cell.c}`;
  if (direction === "down") return `h-${cell.r + 1}-${cell.c}`;
  if (direction === "left") return `v-${cell.r}-${cell.c}`;
  return `v-${cell.r}-${cell.c + 1}`;
}

function assignWall(
  assignments: Map<string, boolean>,
  edge: string,
  value: boolean,
): boolean {
  const existing = assignments.get(edge);
  if (existing !== undefined && existing !== value) return false;
  assignments.set(edge, value);
  return true;
}

function constrainedRotationSequence(
  beads: BeadConfig[],
  turnCount: number,
  targetRounds: Partial<Record<Color, number>>,
  variant = 0,
): { rotations: Rotation[]; gravities: Direction[] } | null {
  const requiredOrientation = new Map<number, number>();
  for (const bead of beads) {
    const round = targetRounds[bead.color];
    if (!round || round < 1 || round > turnCount) return null;
    const orientation = ORIENTATION_GRAVITY.indexOf(bead.exit.direction);
    const existing = requiredOrientation.get(round);
    if (existing !== undefined && existing !== orientation) return null;
    requiredOrientation.set(round, orientation);
  }

  const memo = new Map<string, boolean>();
  const canComplete = (round: number, orientation: number): boolean => {
    if (round > turnCount) return true;
    const stateKey = `${round}:${orientation}`;
    const cached = memo.get(stateKey);
    if (cached !== undefined) return cached;
    const possible = (["cw", "ccw"] as Rotation[]).some((rotation) => {
      const next = (orientation + (rotation === "cw" ? 1 : 3)) % 4;
      const required = requiredOrientation.get(round);
      return (required === undefined || required === next) && canComplete(round + 1, next);
    });
    memo.set(stateKey, possible);
    return possible;
  };
  if (!canComplete(1, 0)) return null;

  const rotations: Rotation[] = [];
  const gravities: Direction[] = ["down"];
  let orientation = 0;
  for (let round = 1; round <= turnCount; round += 1) {
    const options = (["cw", "ccw"] as Rotation[]).filter((rotation) => {
      const next = (orientation + (rotation === "cw" ? 1 : 3)) % 4;
      const required = requiredOrientation.get(round);
      return (required === undefined || required === next) && canComplete(round + 1, next);
    }).sort((a, b) => seededRank(variant, round, orientation, a === "cw" ? 1 : 3) - seededRank(variant, round, orientation, b === "cw" ? 1 : 3));
    if (options.length === 0) return null;
    const rotation = options[0];
    orientation = (orientation + (rotation === "cw" ? 1 : 3)) % 4;
    rotations.push(rotation);
    gravities.push(ORIENTATION_GRAVITY[orientation]);
  }
  return { rotations, gravities };
}

function gravitiesForRotations(rotations: Rotation[]): Direction[] {
  let orientation = 0;
  const gravities: Direction[] = ["down"];
  for (const rotation of rotations) {
    orientation = (orientation + (rotation === "cw" ? 1 : 3)) % 4;
    gravities.push(ORIENTATION_GRAVITY[orientation]);
  }
  return gravities;
}

function sweepStops(
  cell: Cell,
  previousGravity: Direction,
  nextGravity: Direction,
  size: number,
): Cell[] {
  const queue: Cell[] = [{ ...cell }];
  const visited = new Set<string>([key(cell)]);
  const result: Cell[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    for (const direction of [nextGravity, previousGravity]) {
      const next = {
        r: current.r + DIR_DELTA[direction].r,
        c: current.c + DIR_DELTA[direction].c,
      };
      if (inside(next, size) && !visited.has(key(next))) {
        visited.add(key(next));
        queue.push(next);
      }
    }
  }
  return result;
}

function coordinateMatches(a: Cell, b: Cell, direction: Direction): boolean {
  return direction === "up" || direction === "down" ? a.r === b.r : a.c === b.c;
}

function imposeSweepStop(
  base: Map<string, boolean>,
  from: Cell,
  stop: Cell,
  previousGravity: Direction,
  nextGravity: Direction,
): Map<string, boolean> | null {
  const assignments = new Map(base);
  let cursor = { ...from };
  while (!coordinateMatches(cursor, stop, nextGravity)) {
    if (!assignWall(assignments, wallEdgeKey(cursor, previousGravity), true)) return null;
    if (!assignWall(assignments, wallEdgeKey(cursor, nextGravity), false)) return null;
    cursor = {
      r: cursor.r + DIR_DELTA[nextGravity].r,
      c: cursor.c + DIR_DELTA[nextGravity].c,
    };
  }
  const falls = !sameCell(cursor, stop);
  if (falls) {
    if (!assignWall(assignments, wallEdgeKey(cursor, previousGravity), false)) return null;
    while (!sameCell(cursor, stop)) {
      if (!assignWall(assignments, wallEdgeKey(cursor, previousGravity), false)) return null;
      cursor = {
        r: cursor.r + DIR_DELTA[previousGravity].r,
        c: cursor.c + DIR_DELTA[previousGravity].c,
      };
    }
    if (!assignWall(assignments, wallEdgeKey(stop, previousGravity), true)) return null;
  } else {
    if (!assignWall(assignments, wallEdgeKey(stop, previousGravity), true)) return null;
    if (!assignWall(assignments, wallEdgeKey(stop, nextGravity), true)) return null;
  }
  return assignments;
}

function isUpstreamOf(cell: Cell, entry: Cell, direction: Direction): boolean {
  if (direction === "down") return cell.c === entry.c && cell.r <= entry.r;
  if (direction === "up") return cell.c === entry.c && cell.r >= entry.r;
  if (direction === "right") return cell.r === entry.r && cell.c <= entry.c;
  return cell.r === entry.r && cell.c >= entry.c;
}

function imposeSweepDrop(
  base: Map<string, boolean>,
  from: Cell,
  exit: Exit,
  previousGravity: Direction,
): Map<string, boolean> | null {
  const assignments = new Map(base);
  let cursor = { ...from };
  while (true) {
    if (!assignWall(assignments, wallEdgeKey(cursor, previousGravity), true)) return null;
    if (sameCell(cursor, exit.cell)) {
      return assignWall(assignments, wallEdgeKey(cursor, exit.direction), false)
        ? assignments
        : null;
    }
    if (!assignWall(assignments, wallEdgeKey(cursor, exit.direction), false)) return null;
    cursor = {
      r: cursor.r + DIR_DELTA[exit.direction].r,
      c: cursor.c + DIR_DELTA[exit.direction].c,
    };
    if (
      (exit.direction === "up" && cursor.r < exit.cell.r) ||
      (exit.direction === "down" && cursor.r > exit.cell.r) ||
      (exit.direction === "left" && cursor.c < exit.cell.c) ||
      (exit.direction === "right" && cursor.c > exit.cell.c)
    ) return null;
  }
  return null;
}

function imposeSharedTrunk(
  base: Map<string, boolean>,
  exit: Exit,
  size: number,
  length = 3,
): Map<string, boolean> | null {
  const assignments = new Map(base);
  const cells = sharedTrunkCells(exit, size, length);
  // The first cell is the merge mouth: side branches must be allowed to enter
  // it. Only the downstream cells are the fully bounded common channel.
  for (const cell of cells.slice(1)) {
    for (const direction of perpendicularDirections(exit.direction)) {
      if (!assignWall(assignments, wallEdgeKey(cell, direction), true)) return null;
    }
  }
  for (let index = 0; index < cells.length - 1; index += 1) {
    if (!assignWall(assignments, wallEdgeKey(cells[index], exit.direction), false)) return null;
  }
  if (!assignWall(assignments, wallEdgeKey(exit.cell, exit.direction), false)) return null;
  if (!assignWall(assignments, wallEdgeKey(cells[0], oppositeDirection(exit.direction)), false)) return null;
  return assignments;
}

function imposeRetention(
  base: Map<string, boolean>,
  position: Cell,
  size: number,
  release?: Exit,
): Map<string, boolean> | null {
  const assignments = new Map(base);
  for (const direction of outwardRetentionDirections(position, size)) {
    if (release && sameCell(position, release.cell) && direction === release.direction) continue;
    if (!assignWall(assignments, wallEdgeKey(position, direction), true)) return null;
  }
  return assignments;
}

function planBeadWallOptions(
  base: Map<string, boolean>,
  bead: BeadConfig,
  targetRound: number,
  gravities: Direction[],
  size: number,
  variant = 0,
  maxOptions = 8,
): Map<string, boolean>[] {
  const trunkEntry = sharedTrunkCells(bead.exit, size, 3)[0];
  const reachMemo = new Map<string, boolean>();
  const stopsMemo = new Map<string, Cell[]>();
  const stopsFor = (round: number, position: Cell): Cell[] => {
    const stateKey = `${round}:${key(position)}`;
    const cached = stopsMemo.get(stateKey);
    if (cached) return cached;
    const stops = sweepStops(position, gravities[round - 1], gravities[round], size);
    stopsMemo.set(stateKey, stops);
    return stops;
  };
  const canReach = (round: number, position: Cell): boolean => {
    const stateKey = `${round}:${key(position)}`;
    const cached = reachMemo.get(stateKey);
    if (cached !== undefined) return cached;
    if (round === targetRound) {
      const aligned = gravities[round] === bead.exit.direction && isUpstreamOf(position, trunkEntry, bead.exit.direction);
      reachMemo.set(stateKey, aligned);
      return aligned;
    }
    if (round > targetRound) return false;
    const possible = stopsFor(round, position)
      .some((stop) => canReach(round + 1, stop));
    reachMemo.set(stateKey, possible);
    return possible;
  };
  if (!canReach(1, bead.start)) return [];

  let budget = 14000;
  const results: Map<string, boolean>[] = [];
  const search = (
    round: number,
    position: Cell,
    assignments: Map<string, boolean>,
  ): void => {
    budget -= 1;
    if (budget <= 0 || results.length >= maxOptions) return;
    const previousGravity = gravities[round - 1];
    const gravity = gravities[round];
    if (round === targetRound) {
      if (gravity !== bead.exit.direction) return;
      if (!isUpstreamOf(position, trunkEntry, bead.exit.direction)) return;
      const completed = imposeSweepDrop(assignments, position, bead.exit, previousGravity);
      if (completed) results.push(completed);
      return;
    }

    const stops = [...stopsFor(round, position)]
      .filter((stop) => canReach(round + 1, stop))
      .sort((a, b) => {
        const da = Math.abs(a.r - bead.exit.cell.r) + Math.abs(a.c - bead.exit.cell.c);
        const db = Math.abs(b.r - bead.exit.cell.r) + Math.abs(b.c - bead.exit.cell.c);
        return da - db || seededRank(variant, round, a.r, a.c) - seededRank(variant, round, b.r, b.c);
      });
    for (const stop of stops) {
      const nextAssignments = imposeSweepStop(assignments, position, stop, previousGravity, gravity);
      if (!nextAssignments) continue;
      search(round + 1, stop, nextAssignments);
      if (budget <= 0 || results.length >= maxOptions) break;
    }
  };

  search(1, bead.start, base);
  return results;
}

function constructScheduledPuzzle(
  size: number,
  beads: BeadConfig[],
  order: Color[],
  turnCount: number,
  targetRounds: Partial<Record<Color, number>>,
  minLength: number,
  maxLength: number,
  avoidIdleTurns: boolean,
  constructionAttempts = 220,
  fixedRotations?: Rotation[],
): Puzzle | null {
  const attemptLimit = Math.max(1, constructionAttempts);
  const debug = Boolean((globalThis as { __MAZE_DEBUG__?: boolean }).__MAZE_DEBUG__);
  const debugStats: Record<string, number> = {};
  const reject = (reason: string) => {
    if (debug) debugStats[reason] = (debugStats[reason] ?? 0) + 1;
  };
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    const sequenceVariant = attempt + 1;
    const sequence = fixedRotations
      ? { rotations: [...fixedRotations], gravities: gravitiesForRotations(fixedRotations) }
      : constrainedRotationSequence(beads, turnCount, targetRounds, sequenceVariant);
    if (!sequence) { reject("rotation-sequence"); break; }
    let assignments = new Map<string, boolean>();
    let conflict = false;
    for (let c = 0; c < size; c += 1) {
      assignWall(assignments, `h-0-${c}`, true);
      assignWall(assignments, `h-${size}-${c}`, true);
    }
    for (let r = 0; r < size; r += 1) {
      assignWall(assignments, `v-${r}-0`, true);
      assignWall(assignments, `v-${r}-${size}`, true);
    }
    for (const bead of beads) {
      assignments.set(wallEdgeKey(bead.exit.cell, bead.exit.direction), false);
    }
    const trunkAssignments = imposeSharedTrunk(assignments, beads[0].exit, size, 3);
    if (!trunkAssignments) { reject("shared-trunk"); continue; }
    assignments = trunkAssignments;
    for (const bead of beads) {
      if (!assignWall(assignments, wallEdgeKey(bead.start, "down"), true)) {
        conflict = true;
        break;
      }
    }
    if (conflict) { reject("start-platform"); continue; }

    // Keep the requested exit order, but backtrack across alternate panel
    // layouts instead of committing to the first route found for each bead.
    const planningBeads = [...beads].sort((a, b) =>
      (targetRounds[a.color] ?? 0) - (targetRounds[b.color] ?? 0));
    let branchBudget = 24;
    const planAllBeads = (
      beadIndex: number,
      current: Map<string, boolean>,
    ): Map<string, boolean> | null => {
      branchBudget -= 1;
      if (branchBudget <= 0) return null;
      if (beadIndex >= planningBeads.length) return current;
      const bead = planningBeads[beadIndex];
      const targetRound = targetRounds[bead.color];
      if (!targetRound) { reject("missing-target"); return null; }
      const options = planBeadWallOptions(
        current,
        bead,
        targetRound,
        sequence.gravities,
        size,
        attempt * 31 + beadIndex * 7 + 1,
        2,
      );
      if (options.length === 0) reject(`plan-${bead.color}`);
      for (const option of options) {
        const completed = planAllBeads(beadIndex + 1, option);
        if (completed) return completed;
      }
      return null;
    };
    const plannedAssignments = planAllBeads(0, assignments);
    if (!plannedAssignments) continue;
    assignments = plannedAssignments;

    const walls = makeBlankWalls(size, true);
    for (let r = 1; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        const edge = `h-${r}-${c}`;
        walls.h[r][c] = assignments.get(edge) ?? false;
      }
    }
    for (let r = 0; r < size; r += 1) {
      for (let c = 1; c < size; c += 1) {
        const edge = `v-${r}-${c}`;
        walls.v[r][c] = assignments.get(edge) ?? false;
      }
    }
    beads.forEach((bead) => setBoundaryWall(walls, bead.exit.cell, bead.exit.direction, false));

    const network = networkStats(walls, beads[0].start);
    if (network.cells.length < minLength || network.cells.length > maxLength || network.junctions === 0) { reject("network-shape"); continue; }
    if (!beads.every((bead) => network.keys.has(key(bead.start)) && network.keys.has(key(bead.exit.cell)))) { reject("network-connectivity"); continue; }
    const frames = simulateWalls(walls, beads, sequence.rotations);
    const actualRounds: Partial<Record<Color, number>> = {};
    let valid = true;
    for (const frame of frames) {
      for (const event of frame.dropEvents) {
        const expected = beads.find((bead) => bead.color === event.color)!.exit;
        if (!sameCell(event.exit.cell, expected.cell) || event.exit.direction !== expected.direction) {
          valid = false;
          break;
        }
        actualRounds[event.color] = frame.round;
      }
      if (!valid) break;
    }
    if (
      !valid
      || frames.flatMap((frame) => frame.dropped).join("|") !== order.join("|")
      || !beads.every((bead) => actualRounds[bead.color] === targetRounds[bead.color])
    ) { reject("joint-simulation"); continue; }
    if (avoidIdleTurns && frames.slice(1).some((frame) => frame.movementOrder.length === 0 && frame.dropped.length === 0)) { reject("idle-turn"); continue; }

    const paths: MazePath[] = beads.map((bead) => {
      const cells: Cell[] = [{ ...bead.start }];
      frames.slice(1).forEach((frame) => {
        (frame.trajectories[bead.color] ?? []).forEach((cell) => {
          if (!sameCell(cells[cells.length - 1], cell)) cells.push({ ...cell });
        });
      });
      return { color: bead.color, cells, exit: bead.exit.direction };
    });
    const puzzle: Puzzle = {
      rulesVersion: 3,
      size,
      beads: beads.map((bead) => ({ ...bead, start: { ...bead.start }, exit: { cell: { ...bead.exit.cell }, direction: bead.exit.direction } })),
      order: [...order],
      turnCount,
      minLength,
      maxLength,
      rotations: sequence.rotations,
      dropRounds: { ...targetRounds },
      paths,
      referenceWalls: walls,
      solutionLowerBound: 1,
      countedSamples: 0,
      commonChannelLength: 3,
    };
    if (!validateAnswer(puzzle, walls).ok) { reject("validation"); continue; }
    return puzzle;
  }
  if (debug) console.log("maze-generation-rejections", debugStats);
  return null;
}

export function generatePuzzle(
  size: number,
  beads: BeadConfig[],
  order: Color[],
  turnCount: number,
  targetRounds: Partial<Record<Color, number>>,
  minLength: number,
  maxLength: number,
  avoidIdleTurns = false,
  constructionAttempts = 220,
): Puzzle | null {
  if (!allBeadsShareExit(beads)) return null;
  const constructed = constructScheduledPuzzle(
    size,
    beads,
    order,
    turnCount,
    targetRounds,
    minLength,
    maxLength,
    avoidIdleTurns,
    constructionAttempts,
  );
  if (constructed) return constructed;
  const attemptLimit = 1;
  for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
    const paths = randomSharedPathSet(beads, size, minLength, maxLength);
    if (!paths) continue;
    const referenceWalls = pathsToWalls(size, paths);
    const sequence = searchRotationSequence(referenceWalls, beads, order, turnCount, targetRounds);
    if (!sequence) continue;
    if (avoidIdleTurns && simulateWalls(referenceWalls, beads, sequence.rotations)
      .slice(1).some((frame) => frame.movementOrder.length === 0 && frame.dropped.length === 0)) continue;
    const signatures = new Set<string>([wallSignature(referenceWalls)]);
    let samples = 0;
    const sampleBudget = beads.length <= 3 ? 30 : 10;
    for (let sample = 0; sample < sampleBudget; sample += 1) {
      const candidate = randomSharedPathSet(beads, size, minLength, maxLength);
      samples += 1;
      if (candidate && matchesPuzzle(candidate, size, beads, sequence.rotations, sequence.dropRounds)) {
        signatures.add(wallSignature(pathsToWalls(size, candidate)));
      }
    }
    const puzzle: Puzzle = {
      rulesVersion: 3,
      size,
      beads: beads.map((bead) => ({
        ...bead,
        start: { ...bead.start },
        exit: { cell: { ...bead.exit.cell }, direction: bead.exit.direction },
      })),
      order: [...order],
      turnCount,
      minLength,
      maxLength,
      rotations: sequence.rotations,
      dropRounds: sequence.dropRounds,
      paths,
      referenceWalls,
      solutionLowerBound: signatures.size,
      countedSamples: samples,
      commonChannelLength: 3,
    };
    if (!validateAnswer(puzzle, referenceWalls).ok) continue;
    return puzzle;
  }
  return constructScheduledPuzzle(size, beads, order, turnCount, targetRounds, minLength, maxLength, avoidIdleTurns, constructionAttempts);
}

export function generateAutomaticPuzzle(
  size: number,
  beads: BeadConfig[],
  order: Color[],
  maximumTurns: number,
  attempts = 240,
  variantOffset = 0,
  fixedRotations?: Rotation[],
  forbiddenWallKeys: string[] = [],
  initialWalls?: WallGrid,
): Puzzle | null {
  if (!allBeadsShareExit(beads) || order.length !== beads.length) return null;
  if (fixedRotations && forbiddenWallKeys.length === 0 && !initialWalls) {
    const constructed = generatePuzzleForRotations(
      size,
      beads,
      order,
      fixedRotations,
      Math.max(220, Math.ceil(attempts / 4)),
    );
    if (constructed) return constructed;
  }
  const settledPuzzle = generateSettledGravityPuzzle(
    size,
    beads,
    order,
    maximumTurns,
    attempts,
    variantOffset,
    fixedRotations,
    forbiddenWallKeys,
    initialWalls,
  );
  if (settledPuzzle) return settledPuzzle;
  if (fixedRotations) return null;

  // Retain the older corridor sampler as a cheap fallback for small layouts.
  // The authoritative simulation below still uses the V3.5 settled-gravity
  // rule, so a fallback result can never reintroduce the former two-axis move.
  const debug = Boolean((globalThis as { __MAZE_DEBUG__?: boolean }).__MAZE_DEBUG__);
  const rejected = { track: 0, sequence: 0, validation: 0 };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const paths = randomSharedTrackSet(beads, size, 3, size * size);
    if (!paths) { rejected.track += 1; continue; }
    const referenceWalls = pathsToWalls(size, paths);
    const sequence = searchAutomaticRotationSequence(referenceWalls, beads, order, maximumTurns);
    if (!sequence) { rejected.sequence += 1; continue; }
    const puzzle: Puzzle = {
      rulesVersion: 3,
      size,
      beads: beads.map((bead) => ({
        ...bead,
        start: { ...bead.start },
        exit: { cell: { ...bead.exit.cell }, direction: bead.exit.direction },
      })),
      order: [...order],
      turnCount: sequence.rotations.length,
      minLength: 3,
      maxLength: size * size,
      rotations: sequence.rotations,
      dropRounds: sequence.dropRounds,
      paths,
      referenceWalls,
      solutionLowerBound: 1,
      countedSamples: attempt + 1,
      commonChannelLength: 3,
      panelCount: countInternalPanels(referenceWalls),
    };
    const validation = validateAnswer(puzzle, referenceWalls);
    if (validation.ok) return puzzle;
    if (debug && rejected.validation === 0) console.log("automatic-validation-details", validation.details);
    rejected.validation += 1;
  }
  if (debug) console.log("automatic-generation-rejections", rejected);
  return null;
}

export function generatePuzzleForRotations(
  size: number,
  beads: BeadConfig[],
  order: Color[],
  rotations: Rotation[],
  attempts = 220,
): Puzzle | null {
  if (!allBeadsShareExit(beads) || order.length !== beads.length) return null;
  const gravities = gravitiesForRotations(rotations);
  const opportunities = rotations
    .map((_, index) => index + 1)
    .filter((round) => gravities[round] === beads[0].exit.direction);
  if (opportunities.length < beads.length) return null;
  const targetRounds: Partial<Record<Color, number>> = {};
  order.forEach((color, index) => { targetRounds[color] = opportunities[index]; });
  return constructScheduledPuzzle(
    size,
    beads,
    order,
    rotations.length,
    targetRounds,
    3,
    size * size,
    false,
    attempts,
    rotations,
  );
}

type CandidateEvaluation = {
  score: number;
  solved: boolean;
  prefixLength: number;
  frames: SimulationFrame[];
  dropSequence: Color[];
  nextColor?: Color;
  focusCells: Cell[];
};

type MutableEdge = { kind: "h" | "v"; r: number; c: number; edgeKey: string };

function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function orientationForDirection(direction: Direction): number {
  return ORIENTATION_GRAVITY.indexOf(direction);
}

/**
 * Builds a sequence with frequent visits to the outlet orientation. Between
 * two such visits the board takes a genuine 90-degree detour and returns, so
 * balls can be redirected by line inserts before the next possible drop.
 */
function settledRotationCandidate(
  exitDirection: Direction,
  maximumTurns: number,
  variant: number,
  opportunityCount: number,
): Rotation[] | null {
  const target = orientationForDirection(exitDirection);
  const result: Rotation[] = [];
  let q = 0;
  while (q !== target && result.length < maximumTurns) {
    const clockwiseDistance = (target - q + 4) % 4;
    const counterDistance = (q - target + 4) % 4;
    const rotation: Rotation = clockwiseDistance <= counterDistance ? "cw" : "ccw";
    result.push(rotation);
    q = (q + (rotation === "cw" ? 1 : 3)) % 4;
  }
  if (q !== target) return null;

  const initialOpportunity = result.length > 0 ? 1 : 0;
  const remaining = Math.max(0, opportunityCount - initialOpportunity);
  const baseTurns = remaining * 2;
  if (result.length + baseTurns > maximumTurns) return null;
  const longGroups = Math.min(remaining, Math.floor((maximumTurns - result.length - baseTurns) / 2));
  const ranks = Array.from({ length: remaining }, (_, index) => ({
    index,
    rank: seededRank(0x43e8b6a1, variant, index),
  })).sort((a, b) => a.rank - b.rank);
  const longSet = new Set(ranks.slice(0, longGroups).map((item) => item.index));
  for (let opportunity = 0; opportunity < remaining; opportunity += 1) {
    const clockwiseFirst = (seededRank(0x735a2d91, variant, opportunity) & 1) === 0;
    if (longSet.has(opportunity)) {
      result.push(...Array<Rotation>(4).fill(clockwiseFirst ? "cw" : "ccw"));
    } else {
      result.push(clockwiseFirst ? "cw" : "ccw", clockwiseFirst ? "ccw" : "cw");
    }
  }
  return result.length > 0 ? result : null;
}

export function distinctRotationPatterns(
  exitDirection: Direction,
  maximumTurns: number,
  opportunityCount: number,
  limit = 20,
): Rotation[][] {
  const patterns: Rotation[][] = [];
  const signatures = new Set<string>();
  for (let variant = 0; variant < 256 && patterns.length < limit; variant += 1) {
    const pattern = settledRotationCandidate(exitDirection, maximumTurns, variant, opportunityCount);
    if (!pattern) continue;
    const signature = pattern.join("|");
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    patterns.push(pattern);
  }
  return patterns;
}

function fixedSettledWalls(
  size: number,
  beads: BeadConfig[],
  forbiddenWallKeys: string[] = [],
): { walls: WallGrid; fixed: Map<string, boolean>; mutable: MutableEdge[] } | null {
  const walls = makeBlankWalls(size, false);
  const fixed = new Map<string, boolean>();
  const assign = (cell: Cell, direction: Direction, value: boolean): boolean => {
    const edge = wallEdgeKey(cell, direction);
    const existing = fixed.get(edge);
    if (existing !== undefined && existing !== value) return false;
    fixed.set(edge, value);
    if (direction === "up") walls.h[cell.r][cell.c] = value;
    else if (direction === "down") walls.h[cell.r + 1][cell.c] = value;
    else if (direction === "left") walls.v[cell.r][cell.c] = value;
    else walls.v[cell.r][cell.c + 1] = value;
    return true;
  };

  const exit = beads[0].exit;
  if (!assign(exit.cell, exit.direction, false)) return null;
  for (const bead of beads) {
    if (!assign(bead.start, "down", true)) return null;
  }
  const trunk = sharedTrunkCells(exit, size, 1);
  for (const cell of trunk.slice(1)) {
    for (const direction of perpendicularDirections(exit.direction)) {
      if (!assign(cell, direction, true)) return null;
    }
  }
  for (let index = 0; index < trunk.length - 1; index += 1) {
    if (!assign(trunk[index], exit.direction, false)) return null;
  }
  if (!assign(exit.cell, exit.direction, false)) return null;
  const forbidden = new Set(forbiddenWallKeys);
  if (forbiddenWallKeys.some((edge) => fixed.get(edge) === true)) return null;

  const mutable: MutableEdge[] = [];
  for (let r = 1; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      const edgeKey = `h-${r}-${c}`;
      if (!fixed.has(edgeKey) && !forbidden.has(edgeKey)) mutable.push({ kind: "h", r, c, edgeKey });
    }
  }
  for (let r = 0; r < size; r += 1) {
    for (let c = 1; c < size; c += 1) {
      const edgeKey = `v-${r}-${c}`;
      if (!fixed.has(edgeKey) && !forbidden.has(edgeKey)) mutable.push({ kind: "v", r, c, edgeKey });
    }
  }
  return { walls, fixed, mutable };
}

function longestOrderedSubsequence(actual: Color[], expected: Color[]): number {
  const dp = Array.from({ length: actual.length + 1 }, () => Array(expected.length + 1).fill(0));
  for (let i = 1; i <= actual.length; i += 1) {
    for (let j = 1; j <= expected.length; j += 1) {
      dp[i][j] = actual[i - 1] === expected[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[actual.length][expected.length];
}

function evaluateSettledCandidate(
  walls: WallGrid,
  beads: BeadConfig[],
  order: Color[],
  rotations: Rotation[],
): CandidateEvaluation {
  const frames = simulateWalls(walls, beads, rotations);
  const dropSequence = frames.flatMap((frame) => frame.dropped);
  let prefix = 0;
  while (prefix < dropSequence.length && dropSequence[prefix] === order[prefix]) prefix += 1;
  const lcs = longestOrderedSubsequence(dropSequence, order);
  const wrongDrops = dropSequence.length - prefix;
  const nextColor = order[prefix];
  const beadByColor = new Map(beads.map((bead) => [bead.color, bead]));
  const final = frames[frames.length - 1];
  let distancePenalty = 0;
  const trunk = sharedTrunkCells(beads[0].exit, sizeOfWalls(walls), 1);
  const trunkMouth = trunk[0];
  for (let index = prefix; index < order.length; index += 1) {
    const color = order[index];
    const position = final.positions[color];
    const bead = beadByColor.get(color);
    if (position && bead) {
      const distance = Math.abs(position.r - trunkMouth.r) + Math.abs(position.c - trunkMouth.c);
      distancePenalty += distance * Math.max(1, order.length - index);
    } else if (index >= dropSequence.length) {
      distancePenalty += sizeOfWalls(walls) * 3;
    }
  }
  const visited = new Map<Color, Set<string>>();
  beads.forEach((bead) => visited.set(bead.color, new Set([key(bead.start)])));
  frames.slice(1).forEach((frame) => beads.forEach((bead) => {
    (frame.trajectories[bead.color] ?? []).forEach((cell) => visited.get(bead.color)!.add(key(cell)));
  }));
  const trunkCoverage = beads.reduce((sum, bead) =>
    sum + trunk.filter((cell) => visited.get(bead.color)!.has(key(cell))).length, 0);
  const idle = frames.slice(1).filter((frame) => frame.movementOrder.length === 0 && frame.dropped.length === 0).length;
  const exact = dropSequence.length === order.length && dropSequence.every((color, index) => color === order[index]);
  const allUseTrunk = beads.every((bead) => trunk.every((cell) => visited.get(bead.color)!.has(key(cell))));
  const focusCells: Cell[] = [];
  if (nextColor) {
    frames.forEach((frame) => (frame.trajectories[nextColor] ?? []).forEach((cell) => focusCells.push(cell)));
    const position = final.positions[nextColor];
    if (position) {
      focusCells.push(position);
      for (let c = Math.min(position.c, trunkMouth.c); c <= Math.max(position.c, trunkMouth.c); c += 1) {
        focusCells.push({ r: position.r, c });
      }
      for (let r = Math.min(position.r, trunkMouth.r); r <= Math.max(position.r, trunkMouth.r); r += 1) {
        focusCells.push({ r, c: trunkMouth.c });
      }
    }
  }
  const correctDropRounds = frames
    .filter((frame) => frame.dropped.some((color) => order.slice(0, prefix).includes(color)))
    .map((frame) => frame.round);
  const lastCorrectRound = correctDropRounds.length > 0 ? Math.max(...correctDropRounds) : 0;
  return {
    score: prefix * 1_000_000_000
      + lcs * 15_000_000
      + dropSequence.length * 2_000_000
      + trunkCoverage * 100_000
      - wrongDrops * 350_000_000
      - distancePenalty * 1_000
      - lastCorrectRound * 20_000
      - idle * 50,
    solved: exact && allUseTrunk,
    prefixLength: prefix,
    frames,
    dropSequence,
    nextColor,
    focusCells,
  };
}

function sizeOfWalls(walls: WallGrid): number {
  return walls.v[0].length - 1;
}

function edgeNearCells(edge: MutableEdge, cells: Cell[]): boolean {
  return cells.some((cell) => {
    if (edge.kind === "h") return Math.abs(edge.r - cell.r) <= 1 && Math.abs(edge.c - cell.c) <= 1;
    return Math.abs(edge.r - cell.r) <= 1 && Math.abs(edge.c - cell.c) <= 1;
  });
}

function pathsFromFrames(beads: BeadConfig[], frames: SimulationFrame[]): MazePath[] {
  return beads.map((bead) => {
    const cells: Cell[] = [{ ...bead.start }];
    frames.slice(1).forEach((frame) => (frame.trajectories[bead.color] ?? []).forEach((cell) => {
      if (!sameCell(cells[cells.length - 1], cell)) cells.push({ ...cell });
    }));
    return { color: bead.color, cells, exit: bead.exit.direction };
  });
}

/**
 * Reference-style wall search for the V3.5 rules. It searches sparse line
 * inserts while the simulator itself remains the sole judge of motion. This
 * avoids constructing fake blocked cells or predicting a diagonal/centrifugal
 * path that the settled-gravity engine would never execute.
 */
function generateSettledGravityPuzzle(
  size: number,
  beads: BeadConfig[],
  order: Color[],
  maximumTurns: number,
  attempts: number,
  variantOffset = 0,
  fixedRotations?: Rotation[],
  forbiddenWallKeys: string[] = [],
  initialWalls?: WallGrid,
): Puzzle | null {
  const minimumOpportunities = beads.length;
  const target = orientationForDirection(beads[0].exit.direction);
  const initialTurns = target === 0 ? 0 : target === 2 ? 2 : 1;
  if (!fixedRotations && maximumTurns < initialTurns + Math.max(0, minimumOpportunities - 1) * 2) return null;
  if (fixedRotations) {
    let orientation = 0;
    const targetOpportunities = fixedRotations.reduce((count, rotation) => {
      orientation = (orientation + (rotation === "cw" ? 1 : -1) + 4) % 4;
      return count + (orientation === target ? 1 : 0);
    }, 0);
    if (fixedRotations.length !== maximumTurns || targetOpportunities < 1) return null;
  }

  const variants = Math.max(6, Math.min(16, Math.ceil(attempts / 100)));
  const iterationsPerVariant = Math.max(6500, Math.min(14000, Math.ceil(attempts * 30 / variants)));
  for (let variant = 0; variant < variants; variant += 1) {
    const searchVariant = variant + variantOffset;
    const rotations = fixedRotations
      ? [...fixedRotations]
      : settledRotationCandidate(beads[0].exit.direction, maximumTurns, searchVariant, beads.length);
    const fixedLayout = fixedSettledWalls(size, beads, forbiddenWallKeys);
    if (!rotations || !fixedLayout) return null;
    const random = seededRandom(
      0x51ed270b ^ size ^ (maximumTurns << 8) ^ (searchVariant << 16)
      ^ beads.reduce((seed, bead, index) => seed ^ seededRank(index + 1, bead.start.r, bead.start.c), 0),
    );
    let current = initialWalls ? cloneWalls(initialWalls) : cloneWalls(fixedLayout.walls);
    if (initialWalls) {
      fixedLayout.fixed.forEach((value, edgeKey) => {
        const [kind, row, col] = edgeKey.split("-");
        current[kind as "h" | "v"][Number(row)][Number(col)] = value;
      });
      forbiddenWallKeys.forEach((edgeKey) => {
        const [kind, row, col] = edgeKey.split("-");
        current[kind as "h" | "v"][Number(row)][Number(col)] = false;
      });
    } else {
      const density = 0.11 + (variant % 5) * 0.025;
      fixedLayout.mutable.forEach((edge) => {
        current[edge.kind][edge.r][edge.c] = random() < density;
      });
    }
    let currentEval = evaluateSettledCandidate(current, beads, order, rotations);
    let best = cloneWalls(current);
    let bestEval = currentEval;

    for (let iteration = 0; iteration < iterationsPerVariant; iteration += 1) {
      if (bestEval.solved) {
        const lastDropRound = bestEval.frames.reduce(
          (last, frame) => frame.dropped.length ? frame.round : last,
          0,
        );
        const usedRotations = rotations.slice(0, lastDropRound);
        const frames = simulateWalls(best, beads, usedRotations);
        const dropRounds: Partial<Record<Color, number>> = {};
        frames.forEach((frame) => frame.dropped.forEach((color) => { dropRounds[color] = frame.round; }));
        const puzzle: Puzzle = {
          rulesVersion: 3,
          size,
          beads: beads.map((bead) => ({
            ...bead,
            start: { ...bead.start },
            exit: { cell: { ...bead.exit.cell }, direction: bead.exit.direction },
          })),
          order: [...order],
          turnCount: usedRotations.length,
          minLength: 3,
          maxLength: size * size,
          rotations: usedRotations,
          dropRounds,
          paths: pathsFromFrames(beads, frames),
          referenceWalls: best,
          solutionLowerBound: 1,
          countedSamples: (variant + 1) * iterationsPerVariant,
          commonChannelLength: 1,
          panelCount: countInternalPanels(best),
        };
        if (validateAnswer(puzzle, best).ok) return puzzle;
      }

      const candidate = cloneWalls(current);
      const focused = bestEval.focusCells.length > 0 && random() < 0.72;
      const focusEdges = focused
        ? fixedLayout.mutable.filter((edge) => edgeNearCells(edge, bestEval.focusCells))
        : [];
      const pool = focusEdges.length > 0 ? focusEdges : fixedLayout.mutable;
      const closeToSolved = bestEval.prefixLength >= Math.max(1, order.length - 1);
      const mutationCount = closeToSolved
        ? (random() < 0.3 ? 1 : 2 + Math.floor(random() * 4))
        : random() < 0.84 ? 1 : random() < 0.85 ? 2 : 3;
      for (let change = 0; change < mutationCount; change += 1) {
        const edge = pool[Math.floor(random() * pool.length)];
        candidate[edge.kind][edge.r][edge.c] = !candidate[edge.kind][edge.r][edge.c];
      }
      const candidateEval = evaluateSettledCandidate(candidate, beads, order, rotations);
      const temperatureBase = closeToSolved ? 12_000_000 : 2_000_000;
      const temperature = Math.max(2_000, temperatureBase * (1 - iteration / iterationsPerVariant));
      const accept = candidateEval.score >= currentEval.score
        || random() < Math.exp((candidateEval.score - currentEval.score) / temperature);
      if (accept) {
        current = candidate;
        currentEval = candidateEval;
      }
      if (candidateEval.score > bestEval.score || candidateEval.solved) {
        best = cloneWalls(candidate);
        bestEval = candidateEval;
      }
      if (iteration > 0 && iteration % 1200 === 0 && bestEval.score > currentEval.score) {
        current = cloneWalls(best);
        currentEval = bestEval;
      }
    }
    if (Boolean((globalThis as { __MAZE_DEBUG__?: boolean }).__MAZE_DEBUG__)) {
      console.log("settled-search-variant", {
        variant,
        score: bestEval.score,
        drops: bestEval.dropSequence,
        dropRounds: bestEval.frames.filter((frame) => frame.dropped.length).map((frame) => [frame.round, frame.dropped]),
        final: bestEval.frames[bestEval.frames.length - 1].positions,
        solved: bestEval.solved,
      });
    }
  }
  return null;
}

function hasWall(walls: WallGrid, cell: Cell, direction: Direction): boolean {
  if (direction === "up") return walls.h[cell.r][cell.c];
  if (direction === "down") return walls.h[cell.r + 1][cell.c];
  if (direction === "left") return walls.v[cell.r][cell.c];
  return walls.v[cell.r][cell.c + 1];
}

export function outwardRetentionDirections(cell: Cell, size: number): Direction[] {
  const center = size / 2;
  const x = cell.c + 0.5;
  const y = cell.r + 0.5;
  const dx = x - center;
  const dy = y - center;
  if (dx === 0 && dy === 0) return [];
  const horizontal: Direction = dx < 0 ? "left" : "right";
  const vertical: Direction = dy < 0 ? "up" : "down";
  if (Math.abs(dy) > Math.abs(dx)) return [vertical];
  return [horizontal];
}

export function isRotationRetained(
  walls: WallGrid,
  cell: Cell,
  size: number,
  release?: Exit,
): boolean {
  return outwardRetentionDirections(cell, size).every((direction) =>
    Boolean(release && sameCell(cell, release.cell) && direction === release.direction) ||
    hasWall(walls, cell, direction),
  );
}

export function allBeadsShareExit(beads: BeadConfig[]): boolean {
  if (beads.length === 0) return false;
  const common = beads[0].exit;
  return beads.every((bead) => sameCell(bead.exit.cell, common.cell) && bead.exit.direction === common.direction);
}

export function hasStartPlatform(walls: WallGrid, bead: BeadConfig): boolean {
  return hasWall(walls, bead.start, "down");
}

function internalNeighbors(walls: WallGrid, cell: Cell): Cell[] {
  const size = walls.v[0].length - 1;
  return (Object.keys(DIR_DELTA) as Direction[])
    .map((direction) => ({
      direction,
      cell: {
        r: cell.r + DIR_DELTA[direction].r,
        c: cell.c + DIR_DELTA[direction].c,
      },
    }))
    .filter(({ direction, cell: next }) => inside(next, size) && !hasWall(walls, cell, direction))
    .map(({ cell: next }) => next);
}

function componentFrom(walls: WallGrid, start: Cell): Cell[] {
  const queue = [start];
  const visited = new Set<string>([key(start)]);
  const cells: Cell[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    cells.push(current);
    internalNeighbors(walls, current).forEach((next) => {
      if (!visited.has(key(next))) {
        visited.add(key(next));
        queue.push(next);
      }
    });
  }
  return cells;
}

function networkStats(walls: WallGrid, start: Cell) {
  const cells = componentFrom(walls, start);
  const keys = new Set(cells.map(key));
  let edgeSum = 0;
  let junctions = 0;
  cells.forEach((cell) => {
    const degree = internalNeighbors(walls, cell).filter((next) => keys.has(key(next))).length;
    edgeSum += degree;
    if (degree >= 3) junctions += 1;
  });
  const edges = edgeSum / 2;
  return { cells, keys, edges, junctions, cycles: Math.max(0, edges - cells.length + 1) };
}

function movementPriority(
  a: { bead: BeadConfig; position: Cell },
  b: { bead: BeadConfig; position: Cell },
  gravity: Direction,
  beadOrder: Map<Color, number>,
): number {
  if (gravity === "down" && a.position.r !== b.position.r) return b.position.r - a.position.r;
  if (gravity === "up" && a.position.r !== b.position.r) return a.position.r - b.position.r;
  if (gravity === "right" && a.position.c !== b.position.c) return b.position.c - a.position.c;
  if (gravity === "left" && a.position.c !== b.position.c) return a.position.c - b.position.c;
  return (beadOrder.get(a.bead.color) ?? 0) - (beadOrder.get(b.bead.color) ?? 0);
}

type TiltResult = {
  positions: Partial<Record<Color, BallPosition>>;
  dropEvents: DropEvent[];
  blocked: Color[];
  movementOrder: Color[];
  trajectories: Partial<Record<Color, Cell[]>>;
};

function tiltBalls(
  walls: WallGrid,
  beads: BeadConfig[],
  startingPositions: Partial<Record<Color, BallPosition>>,
  gravity: Direction,
): TiltResult {
  const size = walls.v[0].length - 1;
  const positions: Partial<Record<Color, BallPosition>> = {};
  const trajectories: Partial<Record<Color, Cell[]>> = {};
  beads.forEach((bead) => {
    const position = startingPositions[bead.color];
    positions[bead.color] = position ? { ...position } : null;
    trajectories[bead.color] = position ? [{ ...position }] : [];
  });
  const beadOrder = new Map(beads.map((bead, index) => [bead.color, index]));
  const blocked = new Set<Color>();
  const movementOrder: Color[] = [];
  const movedColors = new Set<Color>();
  const dropEvents: DropEvent[] = [];

  for (let guard = 0; guard < size * size * Math.max(1, beads.length) + 4; guard += 1) {
    let movedThisPass = false;
    const occupied = new Map<string, Color>();
    beads.forEach((bead) => {
      const position = positions[bead.color];
      if (position) occupied.set(key(position), bead.color);
    });
    const active = beads
      .map((bead) => ({ bead, position: positions[bead.color] }))
      .filter((item): item is { bead: BeadConfig; position: Cell } => Boolean(item.position))
      .sort((a, b) => movementPriority(a, b, gravity, beadOrder));

    for (const { bead } of active) {
      const current = positions[bead.color];
      if (!current) continue;
      if (hasWall(walls, current, gravity)) continue;
      const next = {
        r: current.r + DIR_DELTA[gravity].r,
        c: current.c + DIR_DELTA[gravity].c,
      };
      if (!inside(next, size)) {
        occupied.delete(key(current));
        positions[bead.color] = null;
        dropEvents.push({ color: bead.color, exit: { cell: { ...current }, direction: gravity } });
        if (!movedColors.has(bead.color)) {
          movementOrder.push(bead.color);
          movedColors.add(bead.color);
        }
        movedThisPass = true;
        continue;
      }
      if (occupied.has(key(next))) {
        blocked.add(bead.color);
        continue;
      }
      occupied.delete(key(current));
      occupied.set(key(next), bead.color);
      positions[bead.color] = next;
      trajectories[bead.color]!.push({ ...next });
      if (!movedColors.has(bead.color)) {
        movementOrder.push(bead.color);
        movedColors.add(bead.color);
      }
      movedThisPass = true;
    }
    if (!movedThisPass) break;
  }

  return {
    positions,
    dropEvents,
    blocked: beads.map((bead) => bead.color).filter((color) => blocked.has(color)),
    movementOrder,
    trajectories,
  };
}

export function simulateWalls(
  walls: WallGrid,
  beads: BeadConfig[],
  rotations: Rotation[],
): SimulationFrame[] {
  let q = 0;
  let angle = 0;
  let positions: Partial<Record<Color, BallPosition>> = {};
  beads.forEach((bead) => { positions[bead.color] = { ...bead.start }; });
  const frames: SimulationFrame[] = [
    {
      round: 0,
      orientation: 0,
      angle: 0,
      gravity: "down",
      positions: { ...positions },
      dropped: [],
      dropEvents: [],
      blocked: [],
      movementOrder: [],
      trajectories: {},
    },
  ];
  rotations.forEach((rotation, index) => {
    const turn = rotation === "cw" ? 1 : -1;
    q = (q + turn + 4) % 4;
    angle += turn * 90;
    const gravity = ORIENTATION_GRAVITY[q];
    const tilt = tiltBalls(walls, beads, positions, gravity);
    positions = tilt.positions;
    frames.push({
      round: index + 1,
      orientation: q,
      angle,
      gravity,
      positions: { ...positions },
      dropped: tilt.dropEvents.map((event) => event.color),
      dropEvents: tilt.dropEvents,
      blocked: tilt.blocked,
      movementOrder: tilt.movementOrder,
      trajectories: tilt.trajectories,
    });
  });
  return frames;
}

function exitKey(exit: Exit, size: number): string {
  if (exit.direction === "up") return `h-0-${exit.cell.c}`;
  if (exit.direction === "down") return `h-${size}-${exit.cell.c}`;
  if (exit.direction === "left") return `v-${exit.cell.r}-0`;
  return `v-${exit.cell.r}-${size}`;
}

function openBoundaryKeys(walls: WallGrid): string[] {
  const size = walls.v[0].length - 1;
  const result: string[] = [];
  for (let c = 0; c < size; c += 1) {
    if (!walls.h[0][c]) result.push(`h-0-${c}`);
    if (!walls.h[size][c]) result.push(`h-${size}-${c}`);
  }
  for (let r = 0; r < size; r += 1) {
    if (!walls.v[r][0]) result.push(`v-${r}-0`);
    if (!walls.v[r][size]) result.push(`v-${r}-${size}`);
  }
  return result;
}

export function validateAnswer(puzzle: Puzzle, walls: WallGrid): ValidationResult {
  const details: string[] = [];
  if (
    puzzle.beads.length !== ALL_COLORS.length
    || !ALL_COLORS.every((color) => puzzle.beads.some((bead) => bead.color === color))
  ) {
    details.push("正式题面必须且只能使用红、黄、蓝、绿、紫五颗珠子。");
  }
  const network = networkStats(walls, puzzle.beads[0].start);
  if (!allBeadsShareExit(puzzle.beads)) {
    details.push("所有珠子必须使用同一个共用出口。");
  }
  puzzle.beads.forEach((bead) => {
    if (!hasStartPlatform(walls, bead)) {
      details.push(`${COLOR_LABEL[bead.color]}珠起点正下方必须有一块直接接触的挡板。`);
    }
    if (!network.keys.has(key(bead.start))) {
      details.push(`${COLOR_LABEL[bead.color]}珠起点没有接入共享迷宫。`);
    }
    if (!network.keys.has(key(bead.exit.cell))) {
      details.push(`${COLOR_LABEL[bead.color]}珠出口没有接入共享迷宫。`);
    }
  });
  if (network.junctions === 0) {
    details.push("禁止使用单通道：共享迷宫至少需要一个三向或四向分叉点。");
  }
  const expectedExits = Array.from(new Set(puzzle.beads.map((bead) => exitKey(bead.exit, puzzle.size)))).sort();
  const actualExits = openBoundaryKeys(walls).sort();
  if (expectedExits.join("|") !== actualExits.join("|")) {
    details.push("盘面开放的边界出口与题目设置不一致。");
  }

  const frames = simulateWalls(walls, puzzle.beads, puzzle.rotations);
  const commonExit = puzzle.beads[0].exit;
  const trunk = sharedTrunkCells(commonExit, puzzle.size, puzzle.commonChannelLength ?? 3);
  // The upstream entry is intentionally allowed to accept side branches; the
  // remaining cells form the visibly bounded shared channel to the exit.
  trunk.slice(1).forEach((cell) => {
    perpendicularDirections(commonExit.direction).forEach((direction) => {
      if (!hasWall(walls, cell, direction)) {
        details.push("共用主通道两侧必须由插板连续约束，不能敞开成一大片区域。");
      }
    });
  });
  for (let index = 0; index < trunk.length - 1; index += 1) {
    if (hasWall(walls, trunk[index], commonExit.direction)) {
      details.push("共用主通道内部被插板截断。");
    }
  }
  const visitedByColor = new Map<Color, Set<string>>();
  puzzle.beads.forEach((bead) => visitedByColor.set(bead.color, new Set([key(bead.start)])));
  frames.slice(1).forEach((frame) => {
    puzzle.beads.forEach((bead) => {
      (frame.trajectories[bead.color] ?? []).forEach((cell) => visitedByColor.get(bead.color)!.add(key(cell)));
    });
  });
  puzzle.beads.forEach((bead) => {
    if (!trunk.every((cell) => visitedByColor.get(bead.color)!.has(key(cell)))) {
      details.push(`${COLOR_LABEL[bead.color]}珠没有完整经过出口前的共用主通道。`);
    }
  });
  const actualRounds: Partial<Record<Color, number>> = {};
  const actualOrder = frames.flatMap((frame) => frame.dropped);
  frames.forEach((frame) => {
    frame.dropEvents.forEach((event) => {
      const expected = puzzle.beads.find((bead) => bead.color === event.color)!.exit;
      if (!sameCell(event.exit.cell, expected.cell) || event.exit.direction !== expected.direction) {
        details.push(`${COLOR_LABEL[event.color]}珠从其他珠子的出口掉落。`);
      }
    });
    if (frame.round > 0) frame.dropped.forEach((color) => { actualRounds[color] = frame.round; });
  });
  puzzle.beads.forEach((bead) => {
    const actual = actualRounds[bead.color] ?? 0;
    const expected = puzzle.dropRounds[bead.color] ?? 0;
    if (actual !== expected) {
      details.push(`${COLOR_LABEL[bead.color]}珠实际${actual ? `在第 ${actual} 次` : "未"}掉落，目标是第 ${expected} 次。`);
    }
  });
  if (actualOrder.join("|") !== puzzle.order.join("|")) {
    details.push(
      `实际掉落顺序为${actualOrder.length ? actualOrder.map((color) => COLOR_LABEL[color]).join("、") : "空"}，目标顺序为${puzzle.order.map((color) => COLOR_LABEL[color]).join("、")}。`,
    );
  }

  if (details.length > 0) {
    return { ok: false, title: "还差一点", details: Array.from(new Set(details)).slice(0, 10), frames };
  }
  return {
    ok: true,
    title: "验证通过",
    details: [`全部珠子均经过出口前 ${trunk.length} 格共用主通道；每轮定位后均沿当前重力滚稳，并按规定顺序从共用出口离场。`],
    frames,
  };
}

export function defaultBeads(size = 10): BeadConfig[] {
  const sharedExit: Exit = { cell: { r: size - 1, c: Math.floor(size / 2) }, direction: "down" };
  return [
    { color: "red", start: { r: 1, c: 1 }, exit: { cell: { ...sharedExit.cell }, direction: sharedExit.direction } },
    { color: "yellow", start: { r: Math.floor(size / 2), c: Math.floor(size / 2) }, exit: { cell: { ...sharedExit.cell }, direction: sharedExit.direction } },
    { color: "blue", start: { r: size - 3, c: size - 3 }, exit: { cell: { ...sharedExit.cell }, direction: sharedExit.direction } },
    { color: "green", start: { r: 1, c: Math.max(2, size - 3) }, exit: { cell: { ...sharedExit.cell }, direction: sharedExit.direction } },
    { color: "purple", start: { r: Math.max(2, size - 3), c: 1 }, exit: { cell: { ...sharedExit.cell }, direction: sharedExit.direction } },
  ];
}

export function countInternalPanels(walls: WallGrid): number {
  const size = walls.v[0].length - 1;
  let count = 0;
  for (let r = 1; r < size; r += 1) for (let c = 0; c < size; c += 1) if (walls.h[r][c]) count += 1;
  for (let r = 0; r < size; r += 1) for (let c = 1; c < size; c += 1) if (walls.v[r][c]) count += 1;
  return count;
}

export function minimizePuzzleWalls(puzzle: Puzzle, trials = 8): Puzzle {
  type Edge = { kind: "h" | "v"; r: number; c: number };
  const baseEdges: Edge[] = [];
  for (let r = 1; r < puzzle.size; r += 1) for (let c = 0; c < puzzle.size; c += 1) {
    if (puzzle.referenceWalls.h[r][c]) baseEdges.push({ kind: "h", r, c });
  }
  for (let r = 0; r < puzzle.size; r += 1) for (let c = 1; c < puzzle.size; c += 1) {
    if (puzzle.referenceWalls.v[r][c]) baseEdges.push({ kind: "v", r, c });
  }
  let best = cloneWalls(puzzle.referenceWalls);
  let bestCount = countInternalPanels(best);
  for (let trial = 0; trial < Math.max(1, trials); trial += 1) {
    const candidate = cloneWalls(puzzle.referenceWalls);
    let changed = true;
    while (changed) {
      changed = false;
      const edges = trial === 0 ? [...baseEdges] : shuffled(baseEdges);
      for (const edge of edges) {
        if (!candidate[edge.kind][edge.r][edge.c]) continue;
        candidate[edge.kind][edge.r][edge.c] = false;
        const testPuzzle = { ...puzzle, referenceWalls: candidate };
        if (validateAnswer(testPuzzle, candidate).ok) changed = true;
        else candidate[edge.kind][edge.r][edge.c] = true;
      }
    }
    const count = countInternalPanels(candidate);
    if (count < bestCount) {
      best = cloneWalls(candidate);
      bestCount = count;
    }
  }
  return {
    ...puzzle,
    referenceWalls: best,
    panelCount: bestCount,
    optimizationTrials: Math.max(1, trials),
  };
}

export function internalPanelKeys(walls: WallGrid): string[] {
  const size = walls.v[0].length - 1;
  const keys: string[] = [];
  for (let r = 1; r < size; r += 1) for (let c = 0; c < size; c += 1) {
    if (walls.h[r][c]) keys.push(`h-${r}-${c}`);
  }
  for (let r = 0; r < size; r += 1) for (let c = 1; c < size; c += 1) {
    if (walls.v[r][c]) keys.push(`v-${r}-${c}`);
  }
  return keys;
}

export function puzzlePathSignature(puzzle: Puzzle): string {
  return puzzle.paths
    .map((path) => `${path.color}:${path.cells.map((cell) => key(cell)).join(";")}:${path.exit}`)
    .join("|");
}

export function puzzleDropScheduleSignature(puzzle: Puzzle): string {
  return puzzle.order.map((color) => `${color}:${puzzle.dropRounds[color] ?? 0}`).join("|");
}

export function isIndependentPuzzleSolution(candidate: Puzzle, accepted: Puzzle[]): boolean {
  if (!validateAnswer(candidate, candidate.referenceWalls).ok) return false;
  const candidateWalls = new Set(internalPanelKeys(candidate.referenceWalls));
  const candidatePath = puzzlePathSignature(candidate);
  const candidateSchedule = puzzleDropScheduleSignature(candidate);
  return accepted.every((existing) => {
    if (puzzlePathSignature(existing) === candidatePath) return false;
    if (puzzleDropScheduleSignature(existing) === candidateSchedule) return false;
    const existingWalls = new Set(internalPanelKeys(existing.referenceWalls));
    const candidateContainsExisting = [...existingWalls].every((edge) => candidateWalls.has(edge));
    const existingContainsCandidate = [...candidateWalls].every((edge) => existingWalls.has(edge));
    return !candidateContainsExisting && !existingContainsCandidate;
  });
}

export function isLocallyMinimalPuzzleSolution(puzzle: Puzzle): boolean {
  if (!validateAnswer(puzzle, puzzle.referenceWalls).ok) return false;
  for (const edge of internalPanelKeys(puzzle.referenceWalls)) {
    const [kind, row, col] = edge.split("-");
    const walls = cloneWalls(puzzle.referenceWalls);
    walls[kind as "h" | "v"][Number(row)][Number(col)] = false;
    if (validateAnswer({ ...puzzle, referenceWalls: walls }, walls).ok) return false;
  }
  return true;
}

export function evenlySpacedDropRounds(
  beads: BeadConfig[],
  turnCount: number,
): Partial<Record<Color, number>> {
  const result: Partial<Record<Color, number>> = {};
  const fiveBeadRatios = [0.25, 0.5, 0.7, 0.9, 1];
  let nextRound = turnCount + 1;
  for (let index = beads.length - 1; index >= 0; index -= 1) {
    const bead = beads[index];
    let target = index === beads.length - 1
      ? turnCount
      : Math.min(
        nextRound - 1,
        Math.round(
          (beads.length === 5 ? fiveBeadRatios[index] : (index + 1) / beads.length) * turnCount,
        ),
      );
    const requiredParity = bead.exit.direction === "left" || bead.exit.direction === "right" ? 1 : 0;
    while (target > 0 && target % 2 !== requiredParity) target -= 1;
    result[bead.color] = target;
    nextRound = target;
  }
  return result;
}

export function compactDropRounds(beads: BeadConfig[]): Partial<Record<Color, number>> {
  const result: Partial<Record<Color, number>> = {};
  let previousRound = 0;
  for (const bead of beads) {
    const horizontalExit = bead.exit.direction === "left" || bead.exit.direction === "right";
    const earliestForGeometry = horizontalExit && bead.start.r !== bead.exit.cell.r ? 3 : horizontalExit ? 1 : 2;
    let target = Math.max(previousRound + 1, earliestForGeometry);
    const requiredParity = horizontalExit ? 1 : 0;
    if (target % 2 !== requiredParity) target += 1;
    result[bead.color] = target;
    previousRound = target;
  }
  return result;
}

export function isDropRoundCompatible(exit: Exit, round: number): boolean {
  const horizontalExit = exit.direction === "left" || exit.direction === "right";
  return round % 2 === (horizontalExit ? 1 : 0);
}

export function resizeBeads(beads: BeadConfig[], oldSize: number, newSize: number): BeadConfig[] {
  const clamp = (value: number) => Math.max(0, Math.min(newSize - 1, Math.round((value / Math.max(1, oldSize - 1)) * (newSize - 1))));
  return beads.map((bead, index) => {
    const start = { r: clamp(bead.start.r), c: clamp(bead.start.c) };
    let direction = bead.exit.direction;
    const cell = { r: clamp(bead.exit.cell.r), c: clamp(bead.exit.cell.c) };
    if (direction === "up") cell.r = 0;
    if (direction === "down") cell.r = newSize - 1;
    if (direction === "left") cell.c = 0;
    if (direction === "right") cell.c = newSize - 1;
    if (index >= newSize * newSize) direction = "up";
    return { ...bead, start, exit: { cell, direction } };
  });
}

export function edgeToExit(kind: "h" | "v", row: number, col: number, size: number): Exit | null {
  if (kind === "h" && row === 0) return { cell: { r: 0, c: col }, direction: "up" };
  if (kind === "h" && row === size) return { cell: { r: size - 1, c: col }, direction: "down" };
  if (kind === "v" && col === 0) return { cell: { r: row, c: 0 }, direction: "left" };
  if (kind === "v" && col === size) return { cell: { r: row, c: size - 1 }, direction: "right" };
  return null;
}

export function exitToEdge(exit: Exit, size: number): { kind: "h" | "v"; row: number; col: number } {
  if (exit.direction === "up") return { kind: "h", row: 0, col: exit.cell.c };
  if (exit.direction === "down") return { kind: "h", row: size, col: exit.cell.c };
  if (exit.direction === "left") return { kind: "v", row: exit.cell.r, col: 0 };
  return { kind: "v", row: exit.cell.r, col: size };
}
