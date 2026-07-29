"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ALL_COLORS,
  BeadConfig,
  COLOR_LABEL,
  Color,
  Exit,
  Puzzle,
  Rotation,
  WallGrid,
  cloneWalls,
  countInternalPanels,
  defaultBeads,
  edgeToExit,
  evenlySpacedDropRounds,
  exitToEdge,
  makeAnswerWalls,
  makeBlankWalls,
  resizeBeads,
  sharedTrunkCells,
  simulateWalls,
  syncBeadSupportWalls,
  validateAnswer,
} from "./maze";

type Tool = "wall" | "erase";
type BoardSource = "answer" | "reference";
type SetupMode = "start" | "exit" | "walls";
type EdgeKind = "h" | "v";
type SavedBoardKind = "answer" | "generated";

type SavedQuestion = {
  id: string;
  name: string;
  savedAt: string;
  size: number;
  beads: BeadConfig[];
  turnCount: number;
  rotations: Rotation[];
  puzzle?: Puzzle;
  solutions?: Puzzle[];
  selectedSolutionIndex?: number;
  answers: SavedBoard[];
};

type SavedBoard = {
  id: string;
  name: string;
  kind: SavedBoardKind;
  savedAt: string;
  size: number;
  beads: BeadConfig[];
  rotations: Rotation[];
  walls: WallGrid;
  puzzle?: Puzzle;
};

type BoardStats = {
  panelCount: number;
  dropCount: number;
  completed: boolean;
  completionRound: number | null;
  events: { round: number; colors: Color[] }[];
};

const QUESTION_LIBRARY_KEY = "旋转之后_v5_题目库";
const BOARD_LIBRARY_KEY = "旋转之后_v5_盘面库";
const SHARE_HASH_PREFIX = "#share=";
const LIBRARY_SHARE_HASH_PREFIX = "#library=";

const gravityLabel = { up: "向上", right: "向右", down: "向下", left: "向左" };
const directionLabel = { up: "上", right: "右", down: "下", left: "左" };
const DEFAULT_ROTATION_PATTERN: Rotation[] = [
  "cw", "ccw", "ccw", "cw", "ccw", "cw", "cw", "ccw", "cw", "ccw",
];

function defaultRotations(count: number): Rotation[] {
  return Array.from(
    { length: count },
    (_, index) => DEFAULT_ROTATION_PATTERN[index % DEFAULT_ROTATION_PATTERN.length],
  );
}

function newLibraryId(prefix: string) {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

function defaultLibraryName(prefix: string, nextIndex: number) {
  return `${prefix} ${nextIndex}`;
}

function questionFingerprint(value: Pick<SavedQuestion | SavedBoard, "size" | "beads" | "rotations">) {
  return JSON.stringify({
    size: value.size,
    beads: value.beads.map((bead) => ({
      color: bead.color,
      start: bead.start,
      exit: bead.exit,
    })),
    rotations: value.rotations,
  });
}

function normalizeSavedLibraries(rawQuestions: unknown, rawBoards: unknown): SavedQuestion[] {
  const questions = (Array.isArray(rawQuestions) ? rawQuestions : [])
    .filter((item): item is SavedQuestion => Boolean(item && typeof item === "object"))
    .map((item) => ({
      ...item,
      answers: Array.isArray(item.answers) ? item.answers : [],
    }));
  const legacyBoards = (Array.isArray(rawBoards) ? rawBoards : [])
    .filter((item): item is SavedBoard => Boolean(item && typeof item === "object"));
  if (legacyBoards.length === 0) return questions;

  const migrated = questions.map((item) => ({ ...item, answers: [...item.answers] }));
  legacyBoards.forEach((board, index) => {
    const fingerprint = questionFingerprint(board);
    let target = migrated.find((question) => questionFingerprint(question) === fingerprint);
    if (!target && migrated.length === 1) target = migrated[0];
    if (!target) {
      target = {
        id: newLibraryId("question"),
        name: `旧题目 ${index + 1}`,
        savedAt: board.savedAt ?? new Date().toISOString(),
        size: board.size,
        beads: structuredClone(board.beads),
        turnCount: board.rotations.length,
        rotations: [...board.rotations],
        puzzle: board.puzzle ? structuredClone(board.puzzle) : undefined,
        solutions: board.puzzle ? [structuredClone(board.puzzle)] : undefined,
        selectedSolutionIndex: board.puzzle ? 0 : undefined,
        answers: [],
      };
      migrated.push(target);
    }
    if (!target.answers.some((answer) => answer.id === board.id)) target.answers.push(board);
  });
  return migrated;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encodeShareData(value: unknown) {
  const source = new TextEncoder().encode(JSON.stringify(value));
  if ("CompressionStream" in window) {
    const compressed = await new Response(
      new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer();
    return `g.${bytesToBase64Url(new Uint8Array(compressed))}`;
  }
  return `j.${bytesToBase64Url(source)}`;
}

async function decodeShareData(token: string): Promise<unknown> {
  if (token.length > 240_000) throw new Error("分享数据过大");
  const [format, payload] = token.split(".", 2);
  let bytes = base64UrlToBytes(payload);
  if (format === "g") {
    if (!("DecompressionStream" in window)) throw new Error("浏览器不支持解压");
    const decompressed = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    bytes = new Uint8Array(decompressed);
  } else if (format !== "j") {
    throw new Error("未知分享格式");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function normalizeSharedQuestion(value: unknown, tokenSuffix: string): SavedQuestion {
  const item = value as SavedQuestion;
  if (
    !item
    || typeof item.name !== "string"
    || !Number.isInteger(item.size)
    || item.size < 5
    || item.size > 16
    || !Array.isArray(item.beads)
    || item.beads.length !== ALL_COLORS.length
    || !Array.isArray(item.rotations)
    || item.rotations.length < 1
    || item.rotations.length > 30
  ) throw new Error("分享内容无效");
  return {
    ...item,
    id: item.id || `shared-${tokenSuffix}`,
    answers: Array.isArray(item.answers) ? item.answers.slice(0, 50) : [],
  };
}

async function decodeSharedQuestion(token: string): Promise<SavedQuestion> {
  return normalizeSharedQuestion(await decodeShareData(token), token.slice(-24));
}

async function decodeSharedLibrary(token: string): Promise<SavedQuestion[]> {
  const value = await decodeShareData(token);
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error("整套题库内容无效");
  }
  return value.map((item, index) => normalizeSharedQuestion(item, `${token.slice(-16)}-${index}`));
}

function boardStats(walls: WallGrid, beads: BeadConfig[], rotations: Rotation[]): BoardStats {
  const frames = simulateWalls(walls, beads, rotations);
  const events = frames
    .filter((frame) => frame.round > 0 && frame.dropped.length > 0)
    .map((frame) => ({ round: frame.round, colors: [...frame.dropped] }));
  const dropCount = events.reduce((count, event) => count + event.colors.length, 0);
  return {
    panelCount: countInternalPanels(walls),
    dropCount,
    completed: dropCount === beads.length,
    completionRound: dropCount === beads.length ? (events.at(-1)?.round ?? 0) : null,
    events,
  };
}

function dropEventText(events: BoardStats["events"]) {
  if (events.length === 0) return "暂无珠子掉落";
  return events
    .map((event) => `第${event.round}轮：${event.colors.map((color) => COLOR_LABEL[color]).join("、")}`)
    .join("；");
}

function cellLabel(row: number, col: number) {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

function exitLabel(exit: Exit) {
  return `${cellLabel(exit.cell.r, exit.cell.c)} · ${directionLabel[exit.direction]}边`;
}

function positionsFromBeads(beads: BeadConfig[]) {
  const positions: Partial<Record<Color, { r: number; c: number } | null>> = {};
  beads.forEach((bead) => { positions[bead.color] = { ...bead.start }; });
  return positions;
}

function framePlaybackDuration(frame: { trajectories: Partial<Record<Color, { r: number; c: number }[]>> }) {
  const longestPath = Math.max(1, ...Object.values(frame.trajectories).map((path) => path?.length ?? 0));
  return 1050 + Math.max(180, (longestPath - 1) * 120);
}

function edgeId(kind: EdgeKind, row: number, col: number) {
  return `${kind}-${row}-${col}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

function saveJson(puzzle: Puzzle) {
  const blob = new Blob([JSON.stringify(puzzle, null, 2)], { type: "application/json;charset=utf-8" });
  downloadBlob(blob, "旋转之后_V5.0_题目.json");
}

function exportPng(
  size: number,
  walls: WallGrid,
  beads: BeadConfig[],
  positions: Partial<Record<Color, { r: number; c: number } | null>>,
): Promise<void> {
  const canvas = document.createElement("canvas");
  const side = 1000;
  const margin = 65;
  const boardSide = side - margin * 2;
  const step = boardSide / size;
  canvas.width = side;
  canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.reject(new Error("当前浏览器无法创建画布"));
  ctx.fillStyle = "#f3efe5";
  ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = "#fffdf7";
  ctx.fillRect(margin, margin, boardSide, boardSide);
  ctx.strokeStyle = "#ded8ca";
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 1) {
    ctx.beginPath(); ctx.moveTo(margin, margin + i * step); ctx.lineTo(margin + boardSide, margin + i * step); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(margin + i * step, margin); ctx.lineTo(margin + i * step, margin + boardSide); ctx.stroke();
  }
  ctx.strokeStyle = "#17211d";
  ctx.lineWidth = Math.max(4, 10 - size / 2);
  ctx.lineCap = "round";
  walls.h.forEach((row, r) => row.forEach((active, c) => {
    if (!active) return;
    ctx.beginPath(); ctx.moveTo(margin + c * step, margin + r * step); ctx.lineTo(margin + (c + 1) * step, margin + r * step); ctx.stroke();
  }));
  walls.v.forEach((row, r) => row.forEach((active, c) => {
    if (!active) return;
    ctx.beginPath(); ctx.moveTo(margin + c * step, margin + r * step); ctx.lineTo(margin + c * step, margin + (r + 1) * step); ctx.stroke();
  }));
  const sharedExit = beads[0]?.exit;
  if (sharedExit) {
    const edge = exitToEdge(sharedExit, size);
    ctx.strokeStyle = "#174e3b";
    ctx.lineWidth = Math.max(7, step * 0.09);
    ctx.beginPath();
    if (edge.kind === "h") {
      const y = margin + edge.row * step;
      ctx.moveTo(margin + edge.col * step + step * 0.18, y);
      ctx.lineTo(margin + (edge.col + 1) * step - step * 0.18, y);
    } else {
      const x = margin + edge.col * step;
      ctx.moveTo(x, margin + edge.row * step + step * 0.18);
      ctx.lineTo(x, margin + (edge.row + 1) * step - step * 0.18);
    }
    ctx.stroke();
  }
  const fills: Record<Color, string> = { red: "#db4d48", yellow: "#e5b92f", blue: "#3478d4", green: "#3b9b62", purple: "#8c59c7" };
  beads.forEach((bead) => {
    const position = positions[bead.color];
    if (!position) return;
    ctx.beginPath();
    ctx.fillStyle = fills[bead.color];
    ctx.arc(margin + (position.c + 0.5) * step, margin + (position.r + 0.5) * step, step * 0.27, 0, Math.PI * 2);
    ctx.fill();
  });
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("PNG 生成失败"));
        return;
      }
      downloadBlob(blob, "旋转之后_V5.0_盘面.png");
      resolve();
    }, "image/png");
  });
}

function configuredExitMap(beads: BeadConfig[], size: number) {
  const map = new Map<string, "shared">();
  const common = beads[0]?.exit;
  if (!common) return map;
  const edge = exitToEdge(common, size);
  map.set(edgeId(edge.kind, edge.row, edge.col), "shared");
  return map;
}

function fullyWalledAnswer(size: number, beads: BeadConfig[]): WallGrid {
  const walls = makeBlankWalls(size, true);
  beads.forEach((bead) => {
    const edge = exitToEdge(bead.exit, size);
    if (edge.kind === "h") walls.h[edge.row][edge.col] = false;
    else walls.v[edge.row][edge.col] = false;
  });
  return walls;
}

function Board({
  size,
  walls,
  beads,
  positions,
  angle,
  editStarts,
  editExits,
  editWalls,
  tool,
  activeColor,
  onEdge,
  onCell,
  onBallPick,
  onBallMove,
}: {
  size: number;
  walls: WallGrid;
  beads: BeadConfig[];
  positions: Partial<Record<Color, { r: number; c: number } | null>>;
  angle: number;
  editStarts: boolean;
  editExits: boolean;
  editWalls: boolean;
  tool: Tool;
  activeColor: Color;
  onEdge: (kind: EdgeKind, row: number, col: number) => void;
  onCell: (row: number, col: number) => void;
  onBallPick: (color: Color) => void;
  onBallMove: (color: Color, row: number, col: number) => void;
}) {
  const step = 100 / size;
  const boardRef = useRef<HTMLDivElement>(null);
  const [draggingBall, setDraggingBall] = useState<Color | null>(null);
  const exits = useMemo(() => configuredExitMap(beads, size), [beads, size]);
  const trunkWalls = useMemo(() => {
    const result = new Set<string>();
    const exit = beads[0]?.exit;
    if (!exit) return result;
    sharedTrunkCells(exit, size, 3).forEach((cell) => {
      if (exit.direction === "up" || exit.direction === "down") {
        result.add(edgeId("v", cell.r, cell.c));
        result.add(edgeId("v", cell.r, cell.c + 1));
      } else {
        result.add(edgeId("h", cell.r, cell.c));
        result.add(edgeId("h", cell.r + 1, cell.c));
      }
    });
    return result;
  }, [beads, size]);

  return (
    <div className="board-stage">
      <div className="gravity-indicator"><span>重力</span><b>↓</b></div>
      <div className="board-rotor" data-angle={angle} style={{ transform: `rotate(${angle}deg)` }}>
        <div
          ref={boardRef}
          className="board"
          style={{ backgroundSize: `${step}% ${step}%` }}
          aria-label={`${size}乘${size}迷宫盘面`}
          onPointerMove={(event) => {
            if (!editStarts || !draggingBall || !boardRef.current) return;
            const rect = boardRef.current.getBoundingClientRect();
            const col = Math.max(0, Math.min(size - 1, Math.floor(((event.clientX - rect.left) / rect.width) * size)));
            const row = Math.max(0, Math.min(size - 1, Math.floor(((event.clientY - rect.top) / rect.height) * size)));
            onBallMove(draggingBall, row, col);
          }}
          onPointerUp={() => setDraggingBall(null)}
          onPointerCancel={() => setDraggingBall(null)}
        >
          {Array.from({ length: size * size }, (_, index) => {
            const row = Math.floor(index / size);
            const col = index % size;
            return (
              <button
                type="button"
                key={`cell-${row}-${col}`}
                className="cell-target"
                style={{ left: `${col * step}%`, top: `${row * step}%`, width: `${step}%`, height: `${step}%` }}
                onClick={() => onCell(row, col)}
                disabled={!editStarts}
                aria-label={`${cellLabel(row, col)}格${editStarts ? `，设置${COLOR_LABEL[activeColor]}珠起点` : ""}`}
              ><span>{cellLabel(row, col)}</span></button>
            );
          })}

          {walls.h.flatMap((row, r) =>
            row.map((active, c) => {
              const boundary = r === 0 || r === size;
              const configuredExit = exits.get(edgeId("h", r, c));
              const enabled = editWalls ? !boundary : editExits && boundary;
              return (
                <button
                  type="button"
                  key={`h-${r}-${c}`}
                  className={`edge horizontal ${active ? "active" : "open"} ${boundary ? "boundary" : ""} ${configuredExit ? "configured-exit exit-shared" : ""} ${trunkWalls.has(edgeId("h", r, c)) ? "common-channel-wall" : ""} ${enabled ? `tool-${tool}` : ""}`}
                  style={{ left: `${c * step}%`, top: `${r * step}%`, width: `${step}%` }}
                  onClick={() => onEdge("h", r, c)}
                  disabled={!enabled}
                  aria-label={`${boundary ? "边界" : "横向边线"}，${configuredExit ? "所有珠子的共用出口" : trunkWalls.has(edgeId("h", r, c)) ? "共用主通道侧墙" : active ? "有墙" : "无墙"}`}
                />
              );
            }),
          )}
          {walls.v.flatMap((row, r) =>
            row.map((active, c) => {
              const boundary = c === 0 || c === size;
              const configuredExit = exits.get(edgeId("v", r, c));
              const enabled = editWalls ? !boundary : editExits && boundary;
              return (
                <button
                  type="button"
                  key={`v-${r}-${c}`}
                  className={`edge vertical ${active ? "active" : "open"} ${boundary ? "boundary" : ""} ${configuredExit ? "configured-exit exit-shared" : ""} ${trunkWalls.has(edgeId("v", r, c)) ? "common-channel-wall" : ""} ${enabled ? `tool-${tool}` : ""}`}
                  style={{ left: `${c * step}%`, top: `${r * step}%`, height: `${step}%` }}
                  onClick={() => onEdge("v", r, c)}
                  disabled={!enabled}
                  aria-label={`${boundary ? "边界" : "纵向边线"}，${configuredExit ? "所有珠子的共用出口" : trunkWalls.has(edgeId("v", r, c)) ? "共用主通道侧墙" : active ? "有墙" : "无墙"}`}
                />
              );
            }),
          )}

          {beads.map((bead) => {
            const position = positions[bead.color];
            if (!position) return null;
            return (
              <div
                key={bead.color}
                className={`ball ball-${bead.color} ${editStarts ? "ball-editable" : ""} ${draggingBall === bead.color ? "dragging" : ""}`}
                style={{
                  left: `${(position.c + 0.5) * step}%`,
                  top: `${(position.r + 0.5) * step}%`,
                  width: `${Math.min(7.2, step * 0.66)}%`,
                  transform: `translate(-50%, -50%) rotate(${-angle}deg)`,
                }}
                aria-label={`${COLOR_LABEL[bead.color]}珠位于${cellLabel(position.r, position.c)}`}
                onPointerDown={(event) => {
                  if (!editStarts) return;
                  event.preventDefault();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  onBallPick(bead.color);
                  setDraggingBall(bead.color);
                }}
              >{COLOR_LABEL[bead.color]}</div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const [size, setSize] = useState(10);
  const [beads, setBeads] = useState<BeadConfig[]>(() => defaultBeads(10));
  const [activeColor, setActiveColor] = useState<Color>("red");
  const [setupMode, setSetupMode] = useState<SetupMode>("start");
  const [turnCount, setTurnCount] = useState(10);
  const [plannedRotations, setPlannedRotations] = useState<Rotation[]>(() => defaultRotations(10));
  const [, setDropTargets] = useState<Partial<Record<Color, number>>>(() => evenlySpacedDropRounds(defaultBeads(10), 10));
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [solutions, setSolutions] = useState<Puzzle[]>([]);
  const [draggedColor, setDraggedColor] = useState<Color | null>(null);
  const [walls, setWalls] = useState<WallGrid>(() => makeAnswerWalls(10, defaultBeads(10)));
  const [undoStack, setUndoStack] = useState<WallGrid[]>([]);
  const [tool, setTool] = useState<Tool>("wall");
  const [source, setSource] = useState<BoardSource>("answer");
  const [round, setRound] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("选择珠子后，可放置起点或点击盘面外边线设置出口。");
  const [validation, setValidation] = useState<ReturnType<typeof validateAnswer> | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [displayAngle, setDisplayAngle] = useState(0);
  const [displayPositions, setDisplayPositions] = useState<Partial<Record<Color, { r: number; c: number } | null>>>(() => positionsFromBeads(defaultBeads(10)));
  const fileInput = useRef<HTMLInputElement>(null);
  const lastAnimatedRound = useRef(0);
  const generationWorker = useRef<Worker | null>(null);
  const beadsRef = useRef(beads);
  const [savedQuestions, setSavedQuestions] = useState<SavedQuestion[]>([]);
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [selectedBoardId, setSelectedBoardId] = useState("");
  const [questionName, setQuestionName] = useState("");
  const [answerName, setAnswerName] = useState("");
  const [storageReady, setStorageReady] = useState(false);

  const activeBead = beads.find((bead) => bead.color === activeColor) ?? beads[0];
  const displayedWalls = source === "reference" && puzzle ? puzzle.referenceWalls : walls;
  const playbackBeads = puzzle?.beads ?? beads;
  const activeRotations = puzzle?.rotations ?? plannedRotations;
  const playbackTurnCount = activeRotations.length;
  const frames = useMemo(() => {
    return simulateWalls(displayedWalls, playbackBeads, activeRotations);
  }, [activeRotations, displayedWalls, playbackBeads]);
  const currentFrame = frames[Math.min(round, frames.length - 1)];
  const boardPositions = displayPositions;
  const currentStats = useMemo(
    () => boardStats(displayedWalls, playbackBeads, activeRotations),
    [activeRotations, displayedWalls, playbackBeads],
  );
  const selectedSavedQuestion = savedQuestions.find((item) => item.id === selectedQuestionId) ?? null;
  const relatedSavedBoards = selectedSavedQuestion?.answers ?? [];
  const selectedSavedBoard = relatedSavedBoards.find((item) => item.id === selectedBoardId) ?? null;
  const selectedSavedBoardStats = useMemo(
    () => selectedSavedBoard
      ? boardStats(selectedSavedBoard.walls, selectedSavedBoard.beads, selectedSavedBoard.rotations)
      : null,
    [selectedSavedBoard],
  );

  useEffect(() => () => generationWorker.current?.terminate(), []);
  useEffect(() => {
    beadsRef.current = beads;
  }, [beads]);

  useEffect(() => {
    void (async () => {
      try {
        const questions = JSON.parse(window.localStorage.getItem(QUESTION_LIBRARY_KEY) ?? "[]");
        const boards = JSON.parse(window.localStorage.getItem(BOARD_LIBRARY_KEY) ?? "[]");
        let normalized = normalizeSavedLibraries(questions, boards);
        if (window.location.hash.startsWith(LIBRARY_SHARE_HASH_PREFIX)) {
          const token = window.location.hash.slice(LIBRARY_SHARE_HASH_PREFIX.length);
          const sharedLibrary = await decodeSharedLibrary(token);
          const sharedIds = new Set(sharedLibrary.map((item) => item.id));
          normalized = [
            ...sharedLibrary,
            ...normalized.filter((item) => !sharedIds.has(item.id)),
          ];
          const first = sharedLibrary[0];
          setSelectedQuestionId(first.id);
          setQuestionName(first.name);
          applySavedQuestion(first);
          setNotice(`已从整库链接载入 ${sharedLibrary.length} 道题及其全部对应解。`);
        } else if (window.location.hash.startsWith(SHARE_HASH_PREFIX)) {
          const token = window.location.hash.slice(SHARE_HASH_PREFIX.length);
          const shared = await decodeSharedQuestion(token);
          const existing = normalized.find((item) => item.id === shared.id);
          normalized = existing
            ? normalized.map((item) => item.id === shared.id ? shared : item)
            : [shared, ...normalized];
          setSelectedQuestionId(shared.id);
          setQuestionName(shared.name);
          applySavedQuestion(shared);
          setNotice(`已从分享链接载入“${shared.name}”及其 ${shared.answers.length} 个解。`);
        }
        setSavedQuestions(normalized);
      } catch {
        setNotice("题库或分享链接读取失败；仍可继续使用程序并重新保存。");
      } finally {
        setStorageReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      window.localStorage.setItem(QUESTION_LIBRARY_KEY, JSON.stringify(savedQuestions));
    } catch {
      window.setTimeout(() => {
        setNotice("本机题库空间不足，请删除不需要的保存项或使用 JSON 文件保存。");
      }, 0);
    }
  }, [savedQuestions, storageReady]);

  useEffect(() => {
    if (!playing) return;
    const finished = round >= playbackTurnCount;
    const timer = window.setTimeout(() => {
      if (finished) setPlaying(false);
      else setRound((value) => value + 1);
    }, finished ? 0 : framePlaybackDuration(currentFrame));
    return () => window.clearTimeout(timer);
  }, [currentFrame, playbackTurnCount, playing, round]);

  useEffect(() => {
    const target = frames[Math.min(round, frames.length - 1)];
    const previousRound = lastAnimatedRound.current;
    lastAnimatedRound.current = round;
    const timers: number[] = [];
    const animationFrame = window.requestAnimationFrame(() => {
      setDisplayAngle(target.angle);
      if (round === 0) {
        setDisplayPositions(positionsFromBeads(playbackBeads));
        return;
      }

      const forwardOneStep = round === previousRound + 1;
      if (!forwardOneStep) {
        timers.push(window.setTimeout(() => setDisplayPositions(target.positions), 500));
        return;
      }

      const longestPath = Math.max(1, ...Object.values(target.trajectories).map((path) => path?.length ?? 0));
      for (let step = 1; step < longestPath; step += 1) {
        timers.push(window.setTimeout(() => {
          const positions: Partial<Record<Color, { r: number; c: number } | null>> = {};
          playbackBeads.forEach((bead) => {
            const path = target.trajectories[bead.color] ?? [];
            positions[bead.color] = path.length > 0
              ? { ...path[Math.min(step, path.length - 1)] }
              : target.positions[bead.color] ?? null;
          });
          setDisplayPositions(positions);
        }, 940 + step * 120));
      }
      timers.push(window.setTimeout(
        () => setDisplayPositions(target.positions),
        1000 + Math.max(1, longestPath - 1) * 120,
      ));
    });
    return () => {
      window.cancelAnimationFrame(animationFrame);
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [frames, playbackBeads, round]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, select, textarea") || target?.isContentEditable) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (round >= playbackTurnCount) setRound(0);
        setPlaying((value) => !value);
      } else if (event.code === "ArrowRight") {
        event.preventDefault();
        setPlaying(false);
        setRound((value) => Math.min(playbackTurnCount, value + 1));
      } else if (event.code === "ArrowLeft") {
        event.preventDefault();
        setPlaying(false);
        setRound((value) => Math.max(0, value - 1));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playbackTurnCount, round]);

  function updateSize(nextSize: number) {
    if (puzzle) return;
    const safe = Math.max(5, Math.min(16, nextSize));
    const nextBeads = resizeBeads(beads, size, safe);
    setBeads(nextBeads);
    setWalls(makeAnswerWalls(safe, nextBeads));
    setUndoStack([]);
    setSize(safe);
    setRound(0);
    setPlaying(false);
    setDisplayAngle(0);
    setDisplayPositions(positionsFromBeads(nextBeads));
    setNotice(`盘面已调整为 ${safe}×${safe}。请检查起点和出口位置。`);
  }

  function updateTurnCount(nextCount: number) {
    if (puzzle) return;
    const safe = Math.max(1, Math.min(30, nextCount));
    setTurnCount(safe);
    setPlannedRotations((current) => Array.from(
      { length: safe },
      (_, index) => current[index] ?? defaultRotations(safe)[index],
    ));
    setDropTargets(evenlySpacedDropRounds(beads, safe));
    setRound(0);
    setPlaying(false);
  }

  function updatePlannedRotation(index: number, rotation: Rotation) {
    if (puzzle) return;
    setPlannedRotations((current) => current.map((item, itemIndex) => itemIndex === index ? rotation : item));
    setRound(0);
    setPlaying(false);
    setValidation(null);
  }

  function chooseStartForColor(color: Color, row: number, col: number) {
    if (puzzle || setupMode !== "start") return;
    const currentBeads = beadsRef.current;
    const occupied = currentBeads.find((bead) => bead.color !== color && bead.start.r === row && bead.start.c === col);
    if (occupied) {
      setNotice(`${COLOR_LABEL[occupied.color]}珠已经占用这个格子。`);
      return;
    }
    const movedBeads = currentBeads.map((bead) => (
      bead.color === color ? { ...bead, start: { r: row, c: col } } : bead
    ));
    setActiveColor(color);
    beadsRef.current = movedBeads;
    setBeads(movedBeads);
    setWalls((current) => syncBeadSupportWalls(current, currentBeads, movedBeads));
    setDisplayPositions((current) => ({ ...current, [color]: { r: row, c: col } }));
    setRound(0);
    setPlaying(false);
    setNotice(`${COLOR_LABEL[color]}珠起点设为 ${cellLabel(row, col)}。`);
  }

  function chooseStart(row: number, col: number) {
    chooseStartForColor(activeColor, row, col);
  }

  function chooseExit(kind: EdgeKind, row: number, col: number) {
    if (puzzle || setupMode !== "exit") return;
    const exit = edgeToExit(kind, row, col, size);
    if (!exit) return;
    const next = beads.map((bead) => ({
      ...bead,
      exit: { cell: { ...exit.cell }, direction: exit.direction },
    }));
    setBeads(next);
    setRound(0);
    setPlaying(false);
    setDropTargets(evenlySpacedDropRounds(next, turnCount));
    setNotice(`共用出口设为 ${exitLabel(exit)}，所有珠子都从这里掉落。`);
  }

  function addBead(color: Color) {
    if (puzzle || beads.some((bead) => bead.color === color)) return;
    const usedStarts = new Set(beads.map((bead) => `${bead.start.r},${bead.start.c}`));
    let start = { r: Math.floor(size / 2), c: Math.floor(size / 2) };
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!usedStarts.has(`${r},${c}`)) { start = { r, c }; r = size; break; }
      }
    }
    const exit: Exit = { cell: { ...beads[0].exit.cell }, direction: beads[0].exit.direction };
    if (beads.length >= 4) {
      const preferredStart = {
        r: Math.min(size - 1, Math.floor(size * 0.4)),
        c: Math.min(size - 1, Math.floor(size * 0.2)),
      };
      if (!usedStarts.has(`${preferredStart.r},${preferredStart.c}`)) start = preferredStart;
    }
    const forbiddenCells = new Set(beads.map((bead) => `${bead.start.r},${bead.start.c}`));
    forbiddenCells.add(`${exit.cell.r},${exit.cell.c}`);
    if (forbiddenCells.has(`${start.r},${start.c}`)) {
      outer: for (let r = 0; r < size; r += 1) {
        for (let c = 0; c < size; c += 1) {
          if (!forbiddenCells.has(`${r},${c}`)) { start = { r, c }; break outer; }
        }
      }
    }
    const next = [...beads, { color, start, exit }];
    setBeads(next);
    setDropTargets(evenlySpacedDropRounds(next, turnCount));
    setActiveColor(color);
    setNotice(`已添加${COLOR_LABEL[color]}珠，请设置它的起点；出口沿用当前共用出口。`);
  }

  function removeBead(color: Color) {
    if (puzzle || beads.length <= 1) return;
    const next = beads.filter((bead) => bead.color !== color);
    setBeads(next);
    setDropTargets(evenlySpacedDropRounds(next, turnCount));
    if (activeColor === color) setActiveColor(next[0].color);
    setNotice(`已删除${COLOR_LABEL[color]}珠。`);
  }

  function changeColor(oldColor: Color, newColor: Color) {
    if (oldColor === newColor || beads.some((bead) => bead.color === newColor)) return;
    setBeads((value) => value.map((bead) => bead.color === oldColor ? { ...bead, color: newColor } : bead));
    setDropTargets((value) => {
      const next = { ...value, [newColor]: value[oldColor] };
      delete next[oldColor];
      return next;
    });
    if (activeColor === oldColor) setActiveColor(newColor);
  }

  function moveBead(color: Color, delta: number) {
    const index = beads.findIndex((bead) => bead.color === color);
    const target = index + delta;
    if (target < 0 || target >= beads.length) return;
    const next = [...beads];
    [next[index], next[target]] = [next[target], next[index]];
    setBeads(next);
    setDropTargets(evenlySpacedDropRounds(next, turnCount));
  }

  function moveBeadBefore(color: Color, targetColor: Color) {
    if (puzzle || color === targetColor) return;
    const next = beads.filter((bead) => bead.color !== color);
    const moving = beads.find((bead) => bead.color === color);
    const target = next.findIndex((bead) => bead.color === targetColor);
    if (!moving || target < 0) return;
    next.splice(target, 0, moving);
    setBeads(next);
    setDropTargets(evenlySpacedDropRounds(next, turnCount));
    setNotice(`掉落顺序已调整：${next.map((bead) => COLOR_LABEL[bead.color]).join(" → ")}。`);
  }

  function editEdge(kind: EdgeKind, row: number, col: number) {
    if (!puzzle) {
      if (setupMode === "exit") {
        chooseExit(kind, row, col);
        return;
      }
      if (setupMode !== "walls") return;
      const boundary = kind === "h" ? row === 0 || row === size : col === 0 || col === size;
      if (boundary) return;
      setUndoStack((stack) => [...stack.slice(-39), cloneWalls(walls)]);
      const next = cloneWalls(walls);
      if (kind === "h") next.h[row][col] = !next.h[row][col];
      else next.v[row][col] = !next.v[row][col];
      setWalls(next);
      setRound(0);
      setPlaying(false);
      setValidation(null);
      return;
    }
    if (source !== "answer") return;
    const boundary = kind === "h" ? row === 0 || row === size : col === 0 || col === size;
    if (boundary) return;
    setUndoStack((stack) => [...stack.slice(-39), cloneWalls(walls)]);
    const next = cloneWalls(walls);
    if (kind === "h") next.h[row][col] = tool === "wall";
    else next.v[row][col] = tool === "wall";
    setWalls(next);
    setRound(0);
    setPlaying(false);
    setValidation(null);
  }

  function checkSettings(): string | null {
    if (beads.length !== 5) return "正式题面必须使用红、黄、蓝、绿、紫五颗珠子。";
    if (new Set(beads.map((bead) => `${bead.start.r},${bead.start.c}`)).size !== beads.length) return "珠子起点不能重叠。";
    const commonExit = beads[0].exit;
    if (!beads.every((bead) => sameLocation(bead.exit.cell, commonExit.cell) && bead.exit.direction === commonExit.direction)) return "所有珠子必须使用同一个共用出口。";
    const reserved = new Set<string>();
    for (const bead of beads) {
      const startKey = `${bead.start.r},${bead.start.c}`;
      const exitCellKey = `${bead.exit.cell.r},${bead.exit.cell.c}`;
      if (reserved.has(startKey) || sameLocation(bead.start, bead.exit.cell)) {
        return "珠子起点不能重叠，也不能放在共用出口格。";
      }
      reserved.add(startKey);
      if (reserved.has(exitCellKey) && exitCellKey === startKey) return "珠子起点不能放在共用出口格。";
    }
    if (turnCount < beads.length) return "旋转次数至少要等于珠子数量。";
    return null;
  }

  function generate(optimizePanels = false) {
    const error = checkSettings();
    if (error) { setNotice(error); return; }
    generationWorker.current?.terminate();
    const worker = new Worker(new URL("./maze-worker.ts", import.meta.url), { type: "module" });
    generationWorker.current = worker;
    setBusy(true);
    setNotice("正在后台生成多套规则解并比较插板数量；可随时取消。");
    worker.onmessage = (event: MessageEvent<{ type: "progress"; message: string } | { type: "result"; puzzles: Puzzle[] }>) => {
      if (event.data.type === "progress") {
        setNotice(event.data.message);
        return;
      }
      const results = event.data.puzzles;
      worker.terminate();
      if (generationWorker.current === worker) generationWorker.current = null;
      if (results.length === 0) {
        setNotice(`这组起点、共用出口和 ${turnCount} 次上限仍未找到完整解；程序已同时尝试你设置的顺逆序列和自动改排。请移动起点或增加旋转次数。`);
        setBusy(false);
        return;
      }
      const result = results[0];
      const sequenceAdjusted = result.rotations.some((rotation, index) => rotation !== plannedRotations[index])
        || result.rotations.length !== plannedRotations.length;
      setSolutions(results);
      setDisplayPositions(positionsFromBeads(result.beads));
      setDisplayAngle(0);
      lastAnimatedRound.current = 0;
      setTurnCount(result.turnCount);
      setPlannedRotations([...result.rotations]);
      setDropTargets({ ...result.dropRounds });
      setPuzzle(result);
      setWalls(makeAnswerWalls(size, result.beads));
      setUndoStack([]);
      setSource("reference");
      setRound(0);
      setValidation(null);
      setNotice(sequenceAdjusted
        ? `原顺逆序列没有完整解，程序已在 ${turnCount} 次上限内自动改排并找到 ${results.length} 套独立解；当前为挡板最少候选（${result.panelCount} 片）。`
        : `已找到 ${results.length} 套路径不同、互非加板关系的独立解；当前显示挡板最少的方案（${result.panelCount} 片）。`);
      setBusy(false);
    };
    worker.onerror = () => {
      worker.terminate();
      if (generationWorker.current === worker) generationWorker.current = null;
      setBusy(false);
      setNotice("后台生成器启动失败，请刷新页面后重试。");
    };
    worker.postMessage({
      type: "generate",
      size,
      beads,
      order: beads.map((bead) => bead.color),
      turnCount,
      rotations: plannedRotations,
      optimizePanels,
    });
  }

  function cancelGeneration() {
    generationWorker.current?.terminate();
    generationWorker.current = null;
    setBusy(false);
    setNotice("已取消后台搜索，可以继续修改设置。");
  }

  function selectSolution(next: Puzzle, index: number) {
    setPuzzle(next);
    setTurnCount(next.turnCount);
    setPlannedRotations([...next.rotations]);
    setDropTargets({ ...next.dropRounds });
    setDisplayPositions(positionsFromBeads(next.beads));
    setDisplayAngle(0);
    lastAnimatedRound.current = 0;
    setWalls(makeAnswerWalls(next.size, next.beads));
    setUndoStack([]);
    setSource("reference");
    setRound(0);
    setPlaying(false);
    setValidation(null);
    setNotice(index === 0
      ? `已切换到候选中插板最少的方案：${next.panelCount} 片。`
      : `已切换到独立解 ${index}：${next.panelCount} 片插板，珠子路线与其他方案不同。`);
  }

  function resetSetup() {
    if (puzzle) {
      setPlannedRotations([...puzzle.rotations]);
      setTurnCount(puzzle.rotations.length);
    }
    setPuzzle(null);
    setSolutions([]);
    setWalls(makeAnswerWalls(size, beads));
    setUndoStack([]);
    setSource("answer");
    setRound(0);
    setPlaying(false);
    setValidation(null);
    setNotice("设置已解锁，可以继续增删珠子或移动起点与出口。 ");
  }

  function fillWalls(filled: boolean) {
    setUndoStack((stack) => [...stack.slice(-39), cloneWalls(walls)]);
    setWalls(filled ? fullyWalledAnswer(size, puzzle?.beads ?? beads) : makeAnswerWalls(size, puzzle?.beads ?? beads));
    setValidation(null);
    setRound(0);
  }

  function undo() {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    setWalls(previous);
    setUndoStack((stack) => stack.slice(0, -1));
    setValidation(null);
  }

  function makeQuestionSnapshot(name: string, id = newLibraryId("question"), answers: SavedBoard[] = []): SavedQuestion {
    return {
      id,
      name,
      savedAt: new Date().toISOString(),
      size,
      beads: structuredClone(beads),
      turnCount,
      rotations: [...plannedRotations],
      puzzle: puzzle ? structuredClone(puzzle) : undefined,
      solutions: solutions.length > 0 ? structuredClone(solutions) : undefined,
      selectedSolutionIndex: puzzle ? Math.max(0, solutions.indexOf(puzzle)) : undefined,
      answers,
    };
  }

  function saveCurrentQuestion() {
    const name = questionName.trim() || defaultLibraryName("题目", savedQuestions.length + 1);
    const item = makeQuestionSnapshot(name);
    setSavedQuestions((items) => [item, ...items]);
    setSelectedQuestionId(item.id);
    setSelectedBoardId("");
    setQuestionName(item.name);
    setAnswerName("");
    setNotice(`“${name}”已保存；现在可以把作答盘面和系统解保存到这道题下面。`);
  }

  function updateCurrentQuestion() {
    if (!selectedSavedQuestion) {
      setNotice("请先选择要更新的题目。");
      return;
    }
    const name = questionName.trim() || selectedSavedQuestion.name;
    const updated = makeQuestionSnapshot(name, selectedSavedQuestion.id, selectedSavedQuestion.answers);
    setSavedQuestions((items) => items.map((item) => item.id === updated.id ? updated : item));
    setQuestionName(updated.name);
    setNotice(`已更新题目“${updated.name}”，它名下的 ${updated.answers.length} 个解已保留。`);
  }

  function applySavedQuestion(item: SavedQuestion) {
    const nextBeads = structuredClone(item.beads);
    const nextSolutions = item.solutions?.length ? structuredClone(item.solutions) : [];
    const nextPuzzle = nextSolutions.length > 0
      ? nextSolutions[Math.min(item.selectedSolutionIndex ?? 0, nextSolutions.length - 1)]
      : item.puzzle ? structuredClone(item.puzzle) : null;
    setSize(item.size);
    setBeads(nextBeads);
    setActiveColor(nextBeads[0]?.color ?? "red");
    setTurnCount(item.turnCount);
    setPlannedRotations([...item.rotations]);
    setPuzzle(nextPuzzle);
    setSolutions(nextSolutions.length > 0 ? nextSolutions : nextPuzzle ? [nextPuzzle] : []);
    setWalls(makeAnswerWalls(item.size, nextBeads));
    setUndoStack([]);
    setSource("answer");
    setSetupMode(nextPuzzle ? "walls" : "start");
    setRound(0);
    setPlaying(false);
    setDisplayAngle(0);
    setDisplayPositions(positionsFromBeads(nextBeads));
    setValidation(null);
  }

  function loadSavedQuestion() {
    const item = savedQuestions.find((question) => question.id === selectedQuestionId);
    if (!item) {
      setNotice("请先从题目下拉框选择一项。");
      return;
    }
    applySavedQuestion(item);
    setQuestionName(item.name);
    setSelectedBoardId("");
    setAnswerName("");
    setNotice(`已载入题目“${item.name}”，作答盘面已重置。`);
  }

  function deleteSavedQuestion() {
    const item = savedQuestions.find((question) => question.id === selectedQuestionId);
    if (!item) return;
    setSavedQuestions((items) => items.filter((question) => question.id !== item.id));
    setSelectedQuestionId("");
    setSelectedBoardId("");
    setQuestionName("");
    setAnswerName("");
    setNotice(`已删除题目“${item.name}”及其 ${item.answers.length} 个关联解。`);
  }

  function saveAnswerBoard() {
    if (!selectedSavedQuestion) {
      setNotice("请先保存或选择一道题，再保存这道题的作答盘面。");
      return;
    }
    const name = answerName.trim() || defaultLibraryName("作答方案", relatedSavedBoards.length + 1);
    const item: SavedBoard = {
      id: newLibraryId("board"),
      name,
      kind: "answer",
      savedAt: new Date().toISOString(),
      size,
      beads: structuredClone(playbackBeads),
      rotations: [...activeRotations],
      walls: cloneWalls(walls),
      puzzle: puzzle ? structuredClone(puzzle) : undefined,
    };
    setSavedQuestions((items) => items.map((question) => (
      question.id === selectedSavedQuestion.id
        ? { ...question, answers: [item, ...question.answers] }
        : question
    )));
    setSelectedBoardId(item.id);
    setAnswerName(item.name);
    setNotice(`“${name}”已保存到题目“${selectedSavedQuestion.name}”：${boardStats(item.walls, item.beads, item.rotations).panelCount} 块插板。`);
  }

  function saveGeneratedSolutions() {
    if (!selectedSavedQuestion) {
      setNotice("请先保存或选择一道题，再保存它的系统解。");
      return;
    }
    const candidates = solutions.length > 0 ? solutions : puzzle ? [puzzle] : [];
    if (candidates.length === 0) {
      setNotice("当前还没有系统生成的解，请先生成解。");
      return;
    }
    const baseName = answerName.trim() || "系统解";
    const created = candidates.map((solution, index): SavedBoard => ({
      id: newLibraryId("solution"),
      name: `${baseName} · ${index === 0 ? "最少挡板" : `独立解 ${index}`}`,
      kind: "generated",
      savedAt: new Date().toISOString(),
      size: solution.size,
      beads: structuredClone(solution.beads),
      rotations: [...solution.rotations],
      walls: cloneWalls(solution.referenceWalls),
      puzzle: structuredClone(solution),
    }));
    setSavedQuestions((items) => items.map((question) => (
      question.id === selectedSavedQuestion.id
        ? { ...question, answers: [...created, ...question.answers] }
        : question
    )));
    setSelectedBoardId(created[0].id);
    setAnswerName(created[0].name);
    setNotice(`已将 ${created.length} 套命名系统解保存到题目“${selectedSavedQuestion.name}”。`);
  }

  function renameSavedBoard() {
    if (!selectedSavedQuestion || !selectedSavedBoard) return;
    const name = answerName.trim();
    if (!name) {
      setNotice("请输入新的解名称。");
      return;
    }
    setSavedQuestions((items) => items.map((question) => (
      question.id === selectedSavedQuestion.id
        ? {
          ...question,
          answers: question.answers.map((answer) => (
            answer.id === selectedSavedBoard.id ? { ...answer, name } : answer
          )),
        }
        : question
    )));
    setNotice(`解已改名为“${name}”。`);
  }

  function loadSavedBoard() {
    const item = selectedSavedBoard;
    if (!item) {
      setNotice("请先从盘面与解的下拉框选择一项。");
      return;
    }
    const nextBeads = structuredClone(item.beads);
    const nextPuzzle = item.puzzle ? structuredClone(item.puzzle) : null;
    setSize(item.size);
    setBeads(nextBeads);
    setActiveColor(nextBeads[0]?.color ?? "red");
    setTurnCount(item.rotations.length);
    setPlannedRotations([...item.rotations]);
    setPuzzle(nextPuzzle);
    setSolutions(nextPuzzle ? [nextPuzzle] : []);
    setWalls(cloneWalls(item.walls));
    setUndoStack([]);
    setSource(item.kind === "generated" && nextPuzzle ? "reference" : "answer");
    setSetupMode("walls");
    setRound(0);
    setPlaying(false);
    setDisplayAngle(0);
    setDisplayPositions(positionsFromBeads(nextBeads));
    setValidation(null);
    setNotice(`已载入“${item.name}”；点击播放即可查看逐轮掉落。`);
  }

  function deleteSavedBoard() {
    if (!selectedSavedQuestion || !selectedSavedBoard) return;
    setSavedQuestions((items) => items.map((question) => (
      question.id === selectedSavedQuestion.id
        ? { ...question, answers: question.answers.filter((item) => item.id !== selectedSavedBoard.id) }
        : question
    )));
    setSelectedBoardId("");
    setAnswerName("");
    setNotice(`已从题目“${selectedSavedQuestion.name}”删除解“${selectedSavedBoard.name}”。`);
  }

  async function shareSelectedQuestion() {
    if (!selectedSavedQuestion) {
      setNotice("请先选择要分享的题目。");
      return;
    }
    try {
      const token = await encodeShareData(selectedSavedQuestion);
      const url = `${window.location.origin}${window.location.pathname}${SHARE_HASH_PREFIX}${token}`;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const input = document.createElement("textarea");
        input.value = url;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      setNotice(`分享链接已复制：别人打开即可看到“${selectedSavedQuestion.name}”及其 ${selectedSavedQuestion.answers.length} 个解。`);
    } catch {
      setNotice("生成分享链接失败，请减少这道题保存的解数量后重试。");
    }
  }

  async function shareWholeLibrary() {
    if (savedQuestions.length === 0) {
      setNotice("请先保存至少一道题目。");
      return;
    }
    try {
      const token = await encodeShareData(savedQuestions);
      const url = `${window.location.origin}${window.location.pathname}${LIBRARY_SHARE_HASH_PREFIX}${token}`;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const input = document.createElement("textarea");
        input.value = url;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        input.remove();
      }
      const solutionCount = savedQuestions.reduce((count, question) => count + question.answers.length, 0);
      setNotice(`整套题库链接已复制：共 ${savedQuestions.length} 道题、${solutionCount} 个对应解。`);
    } catch {
      setNotice("生成整套题库链接失败，请减少保存内容后重试。");
    }
  }

  function importPuzzle(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const value = JSON.parse(String(reader.result)) as Puzzle;
        if (
          value.rulesVersion !== 3
          || !value.size
          || !Array.isArray(value.beads)
          || value.beads.length !== ALL_COLORS.length
          || !ALL_COLORS.every((color) => value.beads.some((bead) => bead.color === color))
          || !value.referenceWalls
          || value.rotations.length > 30
        ) throw new Error();
        const shared = value.beads[0].exit;
        const normalizedBeads = value.beads.map((bead) => ({ ...bead, exit: { cell: { ...shared.cell }, direction: shared.direction } }));
        const normalized = { ...value, beads: normalizedBeads, panelCount: value.panelCount ?? countInternalPanels(value.referenceWalls) };
        setPuzzle(normalized);
        setSolutions([normalized]);
        setSize(value.size);
        setBeads(normalizedBeads);
        setActiveColor(normalizedBeads[0].color);
        setTurnCount(value.turnCount);
        setPlannedRotations([...value.rotations]);
        setDropTargets(value.dropRounds);
        setDisplayPositions(positionsFromBeads(normalizedBeads));
        setDisplayAngle(0);
        lastAnimatedRound.current = 0;
        setWalls(makeAnswerWalls(value.size, normalizedBeads));
        setSource("answer");
        setRound(0);
        setValidation(null);
        setNotice("题目已读取；旧的多出口配置会自动统一到第一个共用出口。 ");
      } catch {
        setNotice("无法读取这个题目文件；V5.0 只接受完整五珠、共用出口的规则题面。");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  const unusedColors = ALL_COLORS.filter((color) => !beads.some((bead) => bead.color === color));
  const rotationAtRound: Rotation | null = round > 0 ? activeRotations[round - 1] : null;
  const manualDropSequence = frames.flatMap((frame) => frame.dropped);

  return (
    <main>
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <i className="dot red-dot" /><i className="dot yellow-dot" /><i className="dot blue-dot" />
        </div>
        <div><p className="eyebrow">旋转之后 · V5.0 RULE ENGINE</p><h1>旋转之后</h1></div>
        <div className="top-actions">
          <button className="text-button" onClick={() => setShowRules(true)}>规则说明</button>
          <button className="text-button" onClick={() => fileInput.current?.click()}>读取题目</button>
          <input ref={fileInput} className="visually-hidden" type="file" accept="application/json,.json" onChange={importPuzzle} />
          {puzzle && <button className="text-button" onClick={() => { saveJson(puzzle); setNotice("题目 JSON 已生成，请在浏览器下载列表中查看。 "); }}>保存题目</button>}
        </div>
      </header>

      <div className="workspace">
        <aside className="control-panel">
          <div className="panel-heading"><span className="step-number">01</span><div><p className="section-kicker">自定义条件</p><h2>珠子、盘面与目标</h2></div></div>

          <section className="library-card" aria-label="题目与对应解">
            <div className="library-heading">
              <div><span className="field-label">题目 → 多个命名解</span><small>先选题目，下方只显示这道题的解</small></div>
            </div>
            <input
              className="library-name-input"
              aria-label="题目名称"
              value={questionName}
              maxLength={28}
              placeholder="题目名称"
              onChange={(event) => setQuestionName(event.target.value)}
            />
            <div className="library-row">
              <select
                aria-label="选择已保存题目"
                value={selectedQuestionId}
                onChange={(event) => {
                  const id = event.target.value;
                  const item = savedQuestions.find((question) => question.id === id);
                  setSelectedQuestionId(id);
                  setSelectedBoardId("");
                  setQuestionName(item?.name ?? "");
                  setAnswerName("");
                }}
              >
                <option value="">选择题目…</option>
                {savedQuestions.map((item) => <option key={item.id} value={item.id}>{item.name}（{item.answers.length} 解）</option>)}
              </select>
              <button type="button" onClick={loadSavedQuestion} disabled={!selectedQuestionId}>载入</button>
              <button type="button" className="danger-lite" onClick={deleteSavedQuestion} disabled={!selectedQuestionId}>删除</button>
            </div>
            <div className="library-actions three">
              <button type="button" className="library-save" onClick={saveCurrentQuestion}>另存新题</button>
              <button type="button" className="library-save" onClick={updateCurrentQuestion} disabled={!selectedQuestionId}>更新当前题</button>
              <button type="button" className="library-save" onClick={shareSelectedQuestion} disabled={!selectedQuestionId}>复制单题</button>
            </div>
            <button type="button" className="library-save library-share-all" onClick={shareWholeLibrary} disabled={savedQuestions.length === 0}>
              复制全部题库链接（{savedQuestions.length} 题）
            </button>

            <div className="library-divider" />
            <div className="library-subheading">
              <strong>{selectedSavedQuestion ? `“${selectedSavedQuestion.name}”的解` : "请先选择题目"}</strong>
              <span>{relatedSavedBoards.length} 个</span>
            </div>
            <input
              className="library-name-input"
              aria-label="解名称"
              value={answerName}
              maxLength={32}
              placeholder="解名称（可保存或改名）"
              disabled={!selectedSavedQuestion}
              onChange={(event) => setAnswerName(event.target.value)}
            />
            <div className="library-row">
              <select
                aria-label="选择当前题目的已保存解"
                value={selectedBoardId}
                disabled={!selectedSavedQuestion}
                onChange={(event) => {
                  const id = event.target.value;
                  const item = relatedSavedBoards.find((answer) => answer.id === id);
                  setSelectedBoardId(id);
                  setAnswerName(item?.name ?? "");
                }}
              >
                <option value="">{selectedSavedQuestion ? "选择这道题的解…" : "请先选择题目"}</option>
                {relatedSavedBoards.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.kind === "generated" ? "系统解" : "作答"} · {item.name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={loadSavedBoard} disabled={!selectedBoardId}>预览</button>
              <button type="button" className="danger-lite" onClick={deleteSavedBoard} disabled={!selectedBoardId}>删除</button>
            </div>
            {selectedSavedBoard && selectedSavedBoardStats && (
              <div className="saved-preview">
                <strong>{selectedSavedBoard.name}</strong>
                <span>{selectedSavedBoardStats.panelCount} 块插板 · {selectedSavedBoardStats.completed ? `${selectedSavedBoardStats.completionRound} 轮完成` : `已掉 ${selectedSavedBoardStats.dropCount}/${selectedSavedBoard.beads.length} 珠`}</span>
                <small>{dropEventText(selectedSavedBoardStats.events)}</small>
              </div>
            )}
            <div className="library-actions">
              <button type="button" className="library-save" onClick={saveAnswerBoard} disabled={!selectedSavedQuestion}>保存当前作答</button>
              <button type="button" className="library-save" onClick={saveGeneratedSolutions} disabled={!selectedSavedQuestion || !puzzle}>保存全部系统解</button>
            </div>
            <button type="button" className="library-save" onClick={renameSavedBoard} disabled={!selectedSavedBoard || !answerName.trim()}>用上方名称改名</button>
            <small className="share-help">发“全部题库链接”即可一次展示所有题目；打开者可从题目下拉框选择每道题及其对应解。</small>
          </section>

          <section className="control-section compact-settings">
            <label><span className="field-label">盘面大小</span><div className="number-unit"><input aria-label="盘面大小" type="number" min={5} max={16} value={size} disabled={Boolean(puzzle)} onChange={(event) => updateSize(Number(event.target.value))} /><span>× {size}</span></div></label>
            <label><span className="field-label">旋转次数上限</span><div className="number-unit"><input aria-label="旋转次数上限" type="number" min={1} max={30} value={turnCount} disabled={Boolean(puzzle)} onChange={(event) => updateTurnCount(Number(event.target.value))} /><span>次</span></div></label>
          </section>

          <section className="control-section">
            <div className="field-row"><span className="field-label">五珠掉落顺序</span><small>拖动整行或使用箭头</small></div>
            <div className="bead-list">
              {beads.map((bead, index) => (
                <div
                  key={bead.color}
                  className={`bead-config ${activeColor === bead.color ? "selected" : ""} ${draggedColor === bead.color ? "dragging" : ""}`}
                  draggable={!puzzle}
                  onClick={() => setActiveColor(bead.color)}
                  onDragStart={(event) => {
                    setDraggedColor(bead.color);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", bead.color);
                  }}
                  onDragOver={(event) => {
                    if (!puzzle) {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const color = (draggedColor ?? event.dataTransfer.getData("text/plain")) as Color;
                    moveBeadBefore(color, bead.color);
                    setDraggedColor(null);
                  }}
                  onDragEnd={() => setDraggedColor(null)}
                >
                  <span className={`mini-ball ${bead.color}`} />
                  <select aria-label={`${COLOR_LABEL[bead.color]}珠颜色`} value={bead.color} disabled={Boolean(puzzle)} onClick={(event) => event.stopPropagation()} onChange={(event) => changeColor(bead.color, event.target.value as Color)}>
                    {ALL_COLORS.map((color) => <option key={color} value={color} disabled={beads.some((item) => item.color === color && item.color !== bead.color)}>{COLOR_LABEL[color]}珠</option>)}
                  </select>
                  <div className="bead-locations"><span>起 {cellLabel(bead.start.r, bead.start.c)}</span><span>共用出口</span></div>
                  <span className="auto-drop-round">轮次自动</span>
                  <div className="reorder-buttons">
                    <button aria-label={`${COLOR_LABEL[bead.color]}珠提前`} disabled={Boolean(puzzle) || index === 0} onClick={(event) => { event.stopPropagation(); moveBead(bead.color, -1); }}>↑</button>
                    <button aria-label={`${COLOR_LABEL[bead.color]}珠延后`} disabled={Boolean(puzzle) || index === beads.length - 1} onClick={(event) => { event.stopPropagation(); moveBead(bead.color, 1); }}>↓</button>
                  </div>
                  <button className="remove-bead" aria-label={`删除${COLOR_LABEL[bead.color]}珠`} disabled={Boolean(puzzle) || beads.length === 1} onClick={(event) => { event.stopPropagation(); removeBead(bead.color); }}>×</button>
                </div>
              ))}
            </div>
            {unusedColors.length > 0 && !puzzle && (
              <div className="add-colors"><span>添加</span>{unusedColors.map((color) => <button key={color} className={`add-${color}`} onClick={() => addBead(color)}>＋{COLOR_LABEL[color]}珠</button>)}</div>
            )}
          </section>

          <section className="control-section">
            <span className="field-label">盘面编辑模式</span>
            <div className="placement-switch">
              <button className={setupMode === "start" ? "selected" : ""} disabled={Boolean(puzzle)} onClick={() => setSetupMode("start")}>放起点</button>
              <button className={setupMode === "exit" ? "selected" : ""} disabled={Boolean(puzzle)} onClick={() => setSetupMode("exit")}>放共用出口</button>
              <button className={setupMode === "walls" ? "selected" : ""} disabled={Boolean(puzzle)} onClick={() => setSetupMode("walls")}>放挡板试玩</button>
            </div>
            <p className="placement-help">
              {setupMode === "start"
                ? <>当前：<b>{COLOR_LABEL[activeBead.color]}珠</b> · 点击或拖动珠子换格</>
                : setupMode === "exit"
                  ? <>当前共用出口：<b>{exitLabel(beads[0].exit)}</b> · 点击盘面最外侧边线</>
                  : <>点击网格线放挡板；在右侧设置每一轮顺/逆 90° 并直接播放</>}
            </p>
          </section>

          {!puzzle ? <div className="generation-actions"><button className="primary-button" onClick={() => generate(true)} disabled={busy}>{busy ? "正在搜索并比较独立解…" : "生成最少挡板解和独立解"}</button>{busy && <button className="text-button cancel-search" onClick={cancelGeneration}>取消搜索</button>}</div> : <button className="secondary-button full" onClick={resetSetup}>修改全部设置</button>}

          {puzzle && (
            <section className="puzzle-card">
              {solutions.length > 1 && (
                <div className="solution-choices" aria-label="可切换的完整解">
                  {solutions.map((solution, index) => (
                    <button
                      type="button"
                      key={`${solution.panelCount}-${index}`}
                      className={solution === puzzle ? "selected" : ""}
                      onClick={() => selectSolution(solution, index)}
                    >
                      <strong>{index === 0 ? "最少挡板" : `独立解 ${index}`}</strong>
                      <span>{solution.panelCount ?? countInternalPanels(solution.referenceWalls)} 片 · {solution.turnCount} 轮</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="card-topline"><span>{puzzle.size}×{puzzle.size} · {puzzle.commonChannelLength ?? 3} 格共用主通道</span><b>{puzzle.turnCount} 次</b></div>
              <div className="drop-schedule">
                {puzzle.order.map((color) => <div key={color}><span className={`mini-ball ${color}`} /><b>{COLOR_LABEL[color]}珠</b><em>第 {puzzle.dropRounds[color]} 次</em></div>)}
              </div>
              <p className="solution-count">内部插板 <strong>{puzzle.panelCount ?? countInternalPanels(puzzle.referenceWalls)}</strong> 片<span>{puzzle.optimizationTrials ? `经过 ${puzzle.optimizationTrials} 轮删板搜索 · 当前搜索最优` : `已确认至少 ${puzzle.solutionLowerBound} 组规则解`}</span></p>
            </section>
          )}
        </aside>

        <section className="board-panel">
          <div className="board-toolbar">
            <div><p className="section-kicker">{puzzle ? "绘制与验证" : setupMode === "start" ? "自由放置起点" : setupMode === "exit" ? "设置共用出口" : "自由放挡板试玩"}</p><h2>{puzzle ? source === "answer" ? "你的迷宫" : "参考迷宫" : `${size}×${size} 自定义盘面`}</h2></div>
            <div className="board-toolbar-actions">
              <div className="board-stat-pill"><span>当前插板</span><strong>{currentStats.panelCount}</strong><small>块</small></div>
              {puzzle && <div className="source-switch"><button className={source === "answer" ? "selected" : ""} onClick={() => { setSource("answer"); setRound(0); }}>我的答案</button><button className={source === "reference" ? "selected" : ""} onClick={() => { setSource("reference"); setRound(0); }}>查看参考</button></div>}
            </div>
          </div>

          {!puzzle && setupMode === "walls" && <div className="drawing-tools"><div className="toggle-wall-hint">单击网格线放置挡板，再点一次取消</div><div className="tool-group subtle"><button onClick={undo} disabled={undoStack.length === 0}>撤销</button><button onClick={() => fillWalls(false)}>清空内墙</button><button onClick={() => fillWalls(true)}>全部封墙</button></div></div>}
          {puzzle && source === "answer" && <div className="drawing-tools"><div className="tool-group"><button className={tool === "wall" ? "selected" : ""} onClick={() => setTool("wall")}><span className="wall-icon" />画墙</button><button className={tool === "erase" ? "selected" : ""} onClick={() => setTool("erase")}><span className="eraser-icon" />擦除内墙</button></div><div className="tool-group subtle"><button onClick={undo} disabled={undoStack.length === 0}>撤销</button><button onClick={() => fillWalls(false)}>清空内墙</button><button onClick={() => fillWalls(true)}>全部封墙</button></div></div>}

          <Board
            size={size}
            walls={displayedWalls}
            beads={puzzle?.beads ?? beads}
            positions={boardPositions}
            angle={displayAngle}
            editStarts={!puzzle && setupMode === "start"}
            editExits={!puzzle && setupMode === "exit"}
            editWalls={(!puzzle && setupMode === "walls") || Boolean(puzzle && source === "answer")}
            tool={tool}
            activeColor={activeColor}
            onEdge={editEdge}
            onCell={chooseStart}
            onBallPick={setActiveColor}
            onBallMove={chooseStartForColor}
          />
          <div className="notice-line" aria-live="polite"><span className="notice-dot" />{notice}</div>
        </section>

        <aside className="sequence-panel">
          <div className="panel-heading compact"><span className="step-number">02</span><div><p className="section-kicker">旋转序列</p><h2>逐步回放</h2></div></div>
          <div className="timeline-summary"><div><span>当前回合</span><strong>{round}<small> / {playbackTurnCount}</small></strong></div><div><span>盘面重力</span><strong>{gravityLabel[currentFrame.gravity]}</strong></div></div>
          <div className="playback-stats" aria-label="当前盘面统计">
            <div><span>插板</span><strong>{currentStats.panelCount}</strong><small>块</small></div>
            <div><span>掉落</span><strong>{currentStats.dropCount}</strong><small> / {playbackBeads.length} 珠</small></div>
            <div><span>完成</span><strong>{currentStats.completed ? currentStats.completionRound : "—"}</strong><small>{currentStats.completed ? "轮" : "未完成"}</small></div>
          </div>
          <div className="drop-event-summary">
            <span>逐轮掉落</span>
            <p>{dropEventText(currentStats.events)}</p>
          </div>
          <div className={`rotation-list ${puzzle ? "" : "rotation-editor"}`} aria-label={puzzle ? "完整旋转序列" : "逐轮顺逆设置"}>
            {activeRotations.map((rotation, index) => {
              const eventColors = frames[index + 1]?.dropped ?? [];
              const eventDots = eventColors.length > 0 && (
                <span
                  className="event-dots"
                  aria-label={`${eventColors.map((color) => `${COLOR_LABEL[color]}珠`).join("、")}掉落`}
                >
                  {eventColors.map((color) => (
                    <i key={color} className={`event-dot ${color}`} title={`${COLOR_LABEL[color]}珠掉落`}>
                      {COLOR_LABEL[color]}
                    </i>
                  ))}
                </span>
              );
              if (!puzzle) {
                return (
                  <div key={`edit-${index}`} className={`${index + 1 === round ? "current" : ""} ${index + 1 < round ? "done" : ""}`}>
                    <button className="round-jump" type="button" onClick={() => { setRound(index + 1); setPlaying(false); }}>{String(index + 1).padStart(2, "0")}</button>
                    <button aria-label={`第 ${index + 1} 次顺90°`} title="顺时针 90°" className={rotation === "cw" ? "selected" : ""} type="button" onClick={() => updatePlannedRotation(index, "cw")}><b>↻</b><em>顺</em></button>
                    <button aria-label={`第 ${index + 1} 次逆90°`} title="逆时针 90°" className={rotation === "ccw" ? "selected" : ""} type="button" onClick={() => updatePlannedRotation(index, "ccw")}><b>↺</b><em>逆</em></button>
                    {eventDots}
                  </div>
                );
              }
              return <button type="button" key={`${rotation}-${index}`} className={`${index + 1 === round ? "current" : ""} ${index + 1 < round ? "done" : ""}`} onClick={() => { setRound(index + 1); setPlaying(false); }}><span className="round-number">{String(index + 1).padStart(2, "0")}</span><b>{rotation === "cw" ? "↻" : "↺"}</b><em>{rotation === "cw" ? "顺时针" : "逆时针"}</em>{eventDots}</button>;
            })}
          </div>
          <div className="playback-controls"><button aria-label="上一步，快捷键左方向键" onClick={() => { setRound((value) => Math.max(0, value - 1)); setPlaying(false); }}>←</button><button className="play-button" onClick={() => { if (round >= playbackTurnCount) setRound(0); setPlaying((value) => !value); }}>{playing ? "暂停" : puzzle ? "播放解答" : "试玩挡板"}</button><button aria-label="下一步，快捷键右方向键" onClick={() => { setRound((value) => Math.min(playbackTurnCount, value + 1)); setPlaying(false); }}>→</button></div>
          <p className="keyboard-hint">空格：播放/暂停　←：上一步　→：下一步</p>
          <div className="current-action">{round === 0 ? <p><span>第 0 轮 · 起点就绪</span>每颗珠子正下方都有直接接触的托板；程序从第一次 90° 旋转后开始按离散规则结算</p> : <p><span>第 {round} 次 · {rotationAtRound === "cw" ? "顺时针 90°" : "逆时针 90°"}</span>{currentFrame.movementOrder.length > 0 ? <>盘面定位后移动：{currentFrame.movementOrder.map((color) => `${COLOR_LABEL[color]}珠`).join(" → ")}</> : "定位后珠子未移动"}{currentFrame.blocked.length > 0 && <em>挡板或占位限制：{currentFrame.blocked.map((color) => `${COLOR_LABEL[color]}珠`).join("、")}</em>}{currentFrame.dropped.length > 0 && <b>{currentFrame.dropped.map((color) => `${COLOR_LABEL[color]}珠`).join("、")}掉落</b>}</p>}</div>
          {puzzle ? (
            <>
              <button className="primary-button" onClick={() => { const result = validateAnswer(puzzle, walls); setValidation(result); setSource("answer"); setRound(0); setNotice(result.ok ? "答案有效，可以播放。" : "已列出需要修改的规则。 "); }}>验证我的迷宫</button>
              <button className="secondary-button full" onClick={() => {
                exportPng(size, displayedWalls, puzzle.beads, currentFrame.positions)
                  .then(() => setNotice("当前盘面 PNG 已生成，请在浏览器下载列表中查看。 "))
                  .catch(() => setNotice("PNG 生成失败，请刷新页面后重试。 "));
              }}>导出当前盘面图片</button>
            </>
          ) : (
            <div className="manual-result">
              <span>当前实际掉落</span>
              <strong>{manualDropSequence.length > 0 ? manualDropSequence.map((color) => COLOR_LABEL[color]).join(" → ") : "尚无珠子离场"}</strong>
              <small>{manualDropSequence.join("|") === beads.map((bead) => bead.color).join("|") ? "顺序正确，五珠全部从共用出口离场。" : "可继续改挡板、起点或每轮旋转方向。"}</small>
            </div>
          )}
        </aside>
      </div>

      {validation && <div className={`validation-toast ${validation.ok ? "success" : "warning"}`}><button className="toast-close" onClick={() => setValidation(null)}>×</button><p className="section-kicker">规则验证</p><h3>{validation.title}</h3><ul>{validation.details.map((detail) => <li key={detail}>{detail}</li>)}</ul>{validation.ok && <button onClick={() => setPlaying(true)}>播放我的答案</button>}</div>}

      {showRules && <div className="modal-backdrop" onMouseDown={() => setShowRules(false)}><section className="rules-modal" onMouseDown={(event) => event.stopPropagation()}><button className="modal-close" onClick={() => setShowRules(false)}>×</button><p className="section-kicker">RULEBOOK · V5.0</p><h2>定位、滚稳与插板规则</h2><ol><li><b>固定五珠。</b>红、黄、蓝、绿、紫五颗珠子必须按选手设定的列表顺序离场；程序自动确定各珠的实际掉落轮次。</li><li><b>只有线形插板。</b>盘底所有格子都可供珠子移动，不允许用整格色块表示障碍；挡板只放在网格线上。</li><li><b>单一共用出口。</b>所有珠子只从同一条外边线离场；重新放置出口会同步更新全部珠子。</li><li><b>必须经过共用主通道。</b>各珠支路可从汇流口的侧面或后方进入；汇流口之后形成连续主通道，并由插板约束到同一出口。</li><li><b>禁止单通道。</b>全部起点与出口必须接入同一共享迷宫，且至少包含一个三向或四向分叉点，不能用五条彼此隔离的通道作答。</li><li><b>起点必须有托板。</b>每颗珠子起点正下方都必须有一块直接接触的挡板，保证第一轮开始前不会自行下落。</li><li><b>先定位，再结算。</b>每轮盘面先完成一次 90° 顺时针或逆时针旋转，再更新规则重力方向；珠子只沿该方向逐格移动到稳定。</li><li><b>出口必须朝向重力。</b>珠子只有在当前规则重力正对共用出口并到达出口格时才能离场；同轮有多珠离场时也必须严格保持设定顺序。</li><li><b>不考虑现实物理。</b>不计算转动惯性、离心力、摩擦、弹跳、滑移、材料误差或电机过程；选手只需满足本程序的离散规则。</li><li><b>珠子互相阻挡。</b>当前方向上更靠前的珠子先移动，后方珠子受占位阻挡。</li><li><b>多解与最少挡板。</b>程序生成若干完整规则解并按内部单位挡板数排序；外框不计，删除挡板不得破坏分叉、共用通道和掉落顺序。</li></ol><button className="primary-button" onClick={() => setShowRules(false)}>明白了</button></section></div>}
    </main>
  );
}

function sameLocation(a: { r: number; c: number }, b: { r: number; c: number }) {
  return a.r === b.r && a.c === b.c;
}
