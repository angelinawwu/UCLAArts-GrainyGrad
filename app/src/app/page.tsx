"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Internal coordinate system. The shape editor always works in this 1500×1000
// space; presets below crop to a sub-rectangle of it for the visible canvas
// + export.
const W = 1500;
const H = 1000;

type Proportion = {
  key: string;
  label: string;
  // [x, y, w, h] within the internal 1500×1000 coordinate system.
  vb: [number, number, number, number];
};
const PROPORTIONS: Proportion[] = [
  { key: "3-2", label: "1500 × 1000 (3:2)", vb: [0, 0, 1500, 1000] },
  // 1000:320 ≈ 3.125:1. Center-crop a 1500×480 slice of the working area.
  { key: "banner", label: "1000 × 320 (banner)", vb: [0, 260, 1500, 480] },
];

type Pt = { x: number; y: number };
type Anchor = { p: Pt; hIn: Pt; hOut: Pt };
type Shape = {
  id: string;
  color: string;
  anchors: Anchor[];
  closed: boolean;
};

type Tool = "select" | "pen";

type Drag =
  | { kind: "anchor"; shapeId: string; idx: number; start: Pt; orig: Anchor }
  | { kind: "handle"; shapeId: string; idx: number; which: "in" | "out"; start: Pt; orig: Pt; mirrorOrig: Pt }
  | { kind: "pen-new"; shapeId: string; idx: number; start: Pt }
  | { kind: "shape"; shapeId: string; start: Pt; origAnchors: Anchor[] }
  | null;

const uid = () => Math.random().toString(36).slice(2, 9);

// Brand palette (UCLA Arts donor stickers)
const BRAND_SWATCHES = [
  { name: "Indigo", hex: "#5640C4" },
  { name: "Sky", hex: "#96D4E4" },
  { name: "Magenta", hex: "#DE1B63" },
  { name: "Yellow", hex: "#F2D43B" },
];
const PALETTE = BRAND_SWATCHES.map((s) => s.hex);

// A wide wavy horizontal band whose top edge undulates and whose bottom
// edge extends past the canvas. With heavy blur these stack into smooth
// banded gradients (like the Figma reference).
function wavyBand(
  yTop: number,
  color: string,
  opts: { waves?: number; amp?: number; phase?: number; segments?: number; overshoot?: number } = {},
): Shape {
  const { waves = 1.5, amp = 110, phase = 0, segments = 8, overshoot = 220 } = opts;
  const anchors: Anchor[] = [];
  const totalW = W + overshoot * 2;
  const dx = totalW / segments / 3;
  for (let i = 0; i <= segments; i++) {
    const x = -overshoot + (totalW * i) / segments;
    const y = yTop + Math.sin((i / segments) * Math.PI * 2 * waves + phase) * amp;
    anchors.push({
      p: { x, y },
      hIn: { x: x - dx, y },
      hOut: { x: x + dx, y },
    });
  }
  // Close along the bottom (well below canvas)
  const yBot = H + overshoot;
  anchors.push({
    p: { x: W + overshoot, y: yBot },
    hIn: { x: W + overshoot, y: yBot - 100 },
    hOut: { x: W + overshoot, y: yBot },
  });
  anchors.push({
    p: { x: -overshoot, y: yBot },
    hIn: { x: -overshoot, y: yBot },
    hOut: { x: -overshoot, y: yBot - 100 },
  });
  return { id: uid(), color, anchors, closed: true };
}

function makeBlob(cx: number, cy: number, rx: number, ry: number, color: string, points = 6): Shape {
  const anchors: Anchor[] = [];
  for (let i = 0; i < points; i++) {
    const a = (i / points) * Math.PI * 2;
    const jitter = 0.85 + Math.random() * 0.3;
    const x = cx + Math.cos(a) * rx * jitter;
    const y = cy + Math.sin(a) * ry * jitter;
    // tangent for circle approximation
    const k = (4 / 3) * Math.tan(Math.PI / (2 * points));
    const tx = -Math.sin(a) * rx * k;
    const ty = Math.cos(a) * ry * k;
    anchors.push({
      p: { x, y },
      hIn: { x: x - tx, y: y - ty },
      hOut: { x: x + tx, y: y + ty },
    });
  }
  return { id: uid(), color, anchors, closed: true };
}

// Default scene per proportion. Yellow background + indigo band + magenta
// band; bands flatten + recenter on the banner preset so they sit inside
// its narrower vertical slice.
const defaultShapesFor = (key: string): Shape[] => {
  if (key === "banner") {
    // Banner viewBox is y 260–740 (centre ≈ 500). Use tighter amplitude.
    return [
      wavyBand(420, "#5640C4", { waves: 1.4, amp: 40, phase: 0.4 }),
      wavyBand(590, "#DE1B63", { waves: 1.2, amp: 45, phase: 1.7 }),
    ];
  }
  return [
    wavyBand(280, "#5640C4", { waves: 1.4, amp: 130, phase: 0.4 }),
    wavyBand(620, "#DE1B63", { waves: 1.2, amp: 150, phase: 1.7 }),
  ];
};

function pathD(s: Shape): string {
  const a = s.anchors;
  if (!a.length) return "";
  let d = `M ${a[0].p.x} ${a[0].p.y}`;
  for (let i = 0; i < a.length - 1; i++) {
    d += ` C ${a[i].hOut.x} ${a[i].hOut.y}, ${a[i + 1].hIn.x} ${a[i + 1].hIn.y}, ${a[i + 1].p.x} ${a[i + 1].p.y}`;
  }
  if (s.closed && a.length > 1) {
    const last = a.length - 1;
    d += ` C ${a[last].hOut.x} ${a[last].hOut.y}, ${a[0].hIn.x} ${a[0].hIn.y}, ${a[0].p.x} ${a[0].p.y} Z`;
  }
  return d;
}

function mirror(p: Pt, anchor: Pt): Pt {
  return { x: 2 * anchor.x - p.x, y: 2 * anchor.y - p.y };
}

export default function Page() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>(() => defaultShapesFor("3-2"));
  const [bg, setBg] = useState("#F2D43B");
  const [tool, setTool] = useState<Tool>("select");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [blur, setBlur] = useState(110);
  const [grain, setGrain] = useState(0.55);
  const [grainScale, setGrainScale] = useState(1.6);
  const [exportSize, setExportSize] = useState(1500);
  const [propKey, setPropKey] = useState<string>("3-2");
  const proportion = PROPORTIONS.find((p) => p.key === propKey) ?? PROPORTIONS[0];
  const [vbX, vbY, vbW, vbH] = proportion.vb;
  const [toast, setToast] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  // Pen drafting state: id of the currently-being-built shape (open).
  const [draftId, setDraftId] = useState<string | null>(null);

  const selected = shapes.find((s) => s.id === selectedId) ?? null;

  // Detect mobile screens
  useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 768);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1600);
  }, []);

  // Convert client (mouse) coordinates to SVG viewBox coordinates.
  const toSvg = useCallback((clientX: number, clientY: number): Pt => {
    const svg = svgRef.current!;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const y = ((clientY - rect.top) / rect.height) * H;
    return { x, y };
  }, []);

  // ---- Pen tool ----
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    if (tool !== "pen") return;
    if ((e.target as Element).closest("[data-anchor-handle]")) return; // ignore handle hits
    const pt = toSvg(e.clientX, e.clientY);

    // Click on first anchor of draft shape closes it.
    const target = (e.target as Element).closest("[data-first-anchor]") as Element | null;
    if (target && draftId && target.getAttribute("data-first-anchor") === draftId) {
      setShapes((prev) => prev.map((s) => (s.id === draftId ? { ...s, closed: true } : s)));
      setSelectedId(draftId);
      setDraftId(null);
      setTool("select");
      return;
    }

    if (!draftId) {
      const id = uid();
      const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      const newShape: Shape = {
        id,
        color,
        closed: false,
        anchors: [{ p: pt, hIn: { ...pt }, hOut: { ...pt } }],
      };
      setShapes((prev) => [...prev, newShape]);
      setDraftId(id);
      setSelectedId(id);
      setDrag({ kind: "pen-new", shapeId: id, idx: 0, start: pt });
    } else {
      // append anchor to draft
      setShapes((prev) =>
        prev.map((s) =>
          s.id === draftId
            ? {
                ...s,
                anchors: [...s.anchors, { p: pt, hIn: { ...pt }, hOut: { ...pt } }],
              }
            : s,
        ),
      );
      setDrag({ kind: "pen-new", shapeId: draftId, idx: -1, start: pt }); // -1 means "last"
    }
  };

  // ---- Mouse move/up at window level for smooth dragging ----
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const pt = toSvg(e.clientX, e.clientY);
      if (drag.kind === "pen-new") {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== drag.shapeId) return s;
            const idx = drag.idx === -1 ? s.anchors.length - 1 : drag.idx;
            const a = s.anchors[idx];
            const newOut = pt;
            const newIn = mirror(pt, a.p);
            const next = [...s.anchors];
            next[idx] = { ...a, hOut: newOut, hIn: newIn };
            return { ...s, anchors: next };
          }),
        );
      } else if (drag.kind === "anchor") {
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== drag.shapeId) return s;
            const next = [...s.anchors];
            const o = drag.orig;
            next[drag.idx] = {
              p: { x: o.p.x + dx, y: o.p.y + dy },
              hIn: { x: o.hIn.x + dx, y: o.hIn.y + dy },
              hOut: { x: o.hOut.x + dx, y: o.hOut.y + dy },
            };
            return { ...s, anchors: next };
          }),
        );
      } else if (drag.kind === "shape") {
        const dx = pt.x - drag.start.x;
        const dy = pt.y - drag.start.y;
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== drag.shapeId) return s;
            return {
              ...s,
              anchors: drag.origAnchors.map((a) => ({
                p: { x: a.p.x + dx, y: a.p.y + dy },
                hIn: { x: a.hIn.x + dx, y: a.hIn.y + dy },
                hOut: { x: a.hOut.x + dx, y: a.hOut.y + dy },
              })),
            };
          }),
        );
      } else if (drag.kind === "handle") {
        setShapes((prev) =>
          prev.map((s) => {
            if (s.id !== drag.shapeId) return s;
            const next = [...s.anchors];
            const a = next[drag.idx];
            const newPos = pt;
            const otherPos = mirror(pt, a.p);
            next[drag.idx] =
              drag.which === "out"
                ? { ...a, hOut: newPos, hIn: otherPos }
                : { ...a, hIn: newPos, hOut: otherPos };
            return { ...s, anchors: next };
          }),
        );
      }
    };
    const onUp = () => setDrag(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, toSvg]);

  // Esc / Enter to finish drafting
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (draftId) {
          setShapes((prev) => prev.filter((s) => s.id !== draftId || s.anchors.length >= 2));
          setShapes((prev) =>
            prev.map((s) => (s.id === draftId ? { ...s, closed: s.anchors.length >= 2 } : s)),
          );
          setDraftId(null);
          setTool("select");
        }
      } else if (e.key === "Enter") {
        if (draftId) {
          setShapes((prev) =>
            prev.map((s) => (s.id === draftId ? { ...s, closed: s.anchors.length >= 2 } : s)),
          );
          setDraftId(null);
          setTool("select");
        }
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedId && !drag && document.activeElement?.tagName !== "INPUT") {
          e.preventDefault();
          setShapes((prev) => prev.filter((s) => s.id !== selectedId));
          setSelectedId(null);
        }
      } else if (e.key === "p" || e.key === "P") {
        setTool("pen");
      } else if (e.key === "v" || e.key === "V") {
        setTool("select");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draftId, selectedId, drag]);

  // ---- Anchor / handle handlers ----
  const onAnchorMouseDown = (e: React.MouseEvent, shapeId: string, idx: number) => {
    e.stopPropagation();
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;

    if (e.altKey) {
      // delete anchor
      setShapes((prev) =>
        prev.map((s) =>
          s.id === shapeId
            ? { ...s, anchors: s.anchors.filter((_, i) => i !== idx) }
            : s,
        ),
      );
      return;
    }

    setSelectedId(shapeId);
    const start = toSvg(e.clientX, e.clientY);
    setDrag({ kind: "anchor", shapeId, idx, start, orig: { ...shape.anchors[idx] } });
  };

  const onHandleMouseDown = (
    e: React.MouseEvent,
    shapeId: string,
    idx: number,
    which: "in" | "out",
  ) => {
    e.stopPropagation();
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape) return;
    setSelectedId(shapeId);
    const start = toSvg(e.clientX, e.clientY);
    const a = shape.anchors[idx];
    setDrag({
      kind: "handle",
      shapeId,
      idx,
      which,
      start,
      orig: which === "out" ? { ...a.hOut } : { ...a.hIn },
      mirrorOrig: which === "out" ? { ...a.hIn } : { ...a.hOut },
    });
  };

  const onPathClick = (e: React.MouseEvent, shapeId: string) => {
    if (tool === "pen") return;
    e.stopPropagation();
    setSelectedId(shapeId);
  };

  // Double-click on selected path to insert an anchor at nearest segment midpoint.
  const onPathDblClick = (e: React.MouseEvent, shapeId: string) => {
    if (tool === "pen") return;
    e.stopPropagation();
    const pt = toSvg(e.clientX, e.clientY);
    setShapes((prev) =>
      prev.map((s) => {
        if (s.id !== shapeId) return s;
        // find nearest anchor pair, insert midpoint between them
        let bestI = 0;
        let bestD = Infinity;
        for (let i = 0; i < s.anchors.length; i++) {
          const next = s.anchors[(i + 1) % s.anchors.length];
          const cx = (s.anchors[i].p.x + next.p.x) / 2;
          const cy = (s.anchors[i].p.y + next.p.y) / 2;
          const d = (cx - pt.x) ** 2 + (cy - pt.y) ** 2;
          if (d < bestD) {
            bestD = d;
            bestI = i;
          }
        }
        const a = s.anchors[bestI];
        const b = s.anchors[(bestI + 1) % s.anchors.length];
        const mid = { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 };
        const newAnchor: Anchor = {
          p: mid,
          hIn: { x: mid.x - 60, y: mid.y },
          hOut: { x: mid.x + 60, y: mid.y },
        };
        const next = [...s.anchors];
        next.splice(bestI + 1, 0, newAnchor);
        return { ...s, anchors: next };
      }),
    );
  };

  // ---- Color editing ----
  const updateShape = (id: string, patch: Partial<Shape>) => {
    setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  };

  // ---- Export to canvas (matches the chosen Proportions) ----
  const renderToCanvas = useCallback(async (): Promise<HTMLCanvasElement> => {
    const exportW = exportSize;
    const exportH = Math.round((exportSize * vbH) / vbW);
    const canvas = document.createElement("canvas");
    canvas.width = exportW;
    canvas.height = exportH;
    const ctx = canvas.getContext("2d")!;

    // Build a clean SVG (without editor chrome) and rasterize.
    // CSS-Tricks "grainy gradient" recipe:
    //   1. Render the smooth blurred gradient (bg + blurred shapes)
    //   2. Generate fine fractalNoise via feTurbulence
    //   3. feBlend mode="overlay" the noise over the gradient
    //   4. Mix the overlayed result back with the source by `grain`
    //      (so grain=0 -> clean gradient, grain=1 -> full overlay)
    const visibleShapes = shapes.filter((s) => s.closed && s.anchors.length >= 2);
    const noiseFreq = 0.9 / Math.max(0.4, grainScale);
    const grainMix = Math.max(0, Math.min(1, grain));
    const pathsSvg = visibleShapes
      .map((s) => `<path d="${pathD(s)}" fill="${s.color}" />`)
      .join("\n      ");
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${vbW} ${vbH}" width="${exportW}" height="${exportH}">
  <defs>
    <filter id="blur_export" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${blur}" />
    </filter>
    <filter id="grainy_export" x="0%" y="0%" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="${noiseFreq}" numOctaves="2" stitchTiles="stitch" seed="3" result="noise" />
      <feBlend in="noise" in2="SourceGraphic" mode="overlay" result="overlayed" />
      <feComposite in="overlayed" in2="SourceGraphic" operator="arithmetic" k1="0" k2="${grainMix}" k3="${1 - grainMix}" k4="0" />
    </filter>
  </defs>
  <g filter="url(#grainy_export)">
    <rect x="${vbX}" y="${vbY}" width="${vbW}" height="${vbH}" fill="${bg}" />
    <g filter="url(#blur_export)">
      ${pathsSvg}
    </g>
  </g>
</svg>`.trim();

    const blob = new Blob([svg], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = (e) => rej(e);
      img.src = url;
    });
    ctx.drawImage(img, 0, 0, exportW, exportH);
    URL.revokeObjectURL(url);

    return canvas;
  }, [shapes, bg, blur, grain, grainScale, exportSize, vbX, vbY, vbW, vbH]);

  const onCopy = async () => {
    try {
      const canvas = await renderToCanvas();
      const blob: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error("blob failed"))), "image/png"),
      );
      // ClipboardItem may need to be lazily evaluated for permissions
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("Copied PNG to clipboard");
    } catch (err) {
      console.error(err);
      showToast("Copy failed — try Download");
    }
  };

  const onDownload = async () => {
    const canvas = await renderToCanvas();
    const url = canvas.toDataURL("image/png");
    const a = document.createElement("a");
    a.href = url;
    a.download = `gradient-${Date.now()}.png`;
    a.click();
  };

  const moveShape = (id: string, dir: -1 | 1) => {
    setShapes((prev) => {
      const i = prev.findIndex((s) => s.id === id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const addBlob = () => {
    const color = PALETTE[Math.floor(Math.random() * PALETTE.length)];
    const cx = 300 + Math.random() * (W - 600);
    const cy = 250 + Math.random() * (H - 500);
    const r = 280 + Math.random() * 200;
    const s = makeBlob(cx, cy, r, r * 0.85, color);
    setShapes((prev) => [...prev, s]);
    setSelectedId(s.id);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-950 text-neutral-100 select-none">
      {isMobile ? (
        <div className="flex items-center justify-center w-full h-full p-6">
          <div className="text-center max-w-md">
            <h1 className="text-2xl font-medium mb-3">Sorry, this application does not work on mobile.</h1>
            <p className="text-white/60">Please try on a desktop device for the best experience.</p>
          </div>
        </div>
      ) : (
        <>
          {/* Left toolbar */}
          <aside className="w-14 shrink-0 border-r border-white/10 flex flex-col items-center py-3 gap-2">
        <ToolBtn
          label="Select (V)"
          active={tool === "select"}
          onClick={() => setTool("select")}
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
            <path d="M5 3l14 8-6 1.5L10 19z" />
          </svg>
        </ToolBtn>
        <ToolBtn
          label="Pen (P)"
          active={tool === "pen"}
          onClick={() => {
            if (tool === "pen") {
              if (draftId) {
                setShapes((prev) =>
                  prev.map((s) => (s.id === draftId ? { ...s, closed: s.anchors.length >= 2 } : s)),
                );
                setDraftId(null);
              }
              setTool("select");
            } else {
              setTool("pen");
            }
          }}
        >
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3 21l4-1 11-11-3-3L4 17l-1 4z" />
            <path d="M14 6l3 3" />
          </svg>
        </ToolBtn>
        <div className="h-px w-8 bg-white/10 my-2" />
        <ToolBtn label="Add blob" onClick={addBlob}>
          <svg viewBox="0 0 24 24" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </ToolBtn>
      </aside>

      {/* Canvas area */}
      <main className="flex-1 min-w-0 flex items-center justify-center p-6">
        <div
          className="relative w-full max-w-[1200px] rounded-xl overflow-hidden ring-1 ring-white/10 shadow-2xl"
          style={{ cursor: tool === "pen" ? "crosshair" : "default", aspectRatio: `${vbW} / ${vbH}` }}
        >
          <svg
            ref={svgRef}
            viewBox={`${vbX} ${vbY} ${vbW} ${vbH}`}
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full"
            onMouseDown={onCanvasMouseDown}
            onClick={(e) => {
              if (tool === "select" && e.target === svgRef.current) setSelectedId(null);
            }}
          >
            <defs>
              <filter id="blurFilter" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation={blur} />
              </filter>
              <filter id="grainyFilter" x="0%" y="0%" width="100%" height="100%">
                <feTurbulence
                  type="fractalNoise"
                  baseFrequency={0.9 / Math.max(0.4, grainScale)}
                  numOctaves={2}
                  seed={3}
                  stitchTiles="stitch"
                  result="noise"
                />
                <feBlend in="noise" in2="SourceGraphic" mode="overlay" result="overlayed" />
                <feComposite
                  in="overlayed"
                  in2="SourceGraphic"
                  operator="arithmetic"
                  k1={0}
                  k2={grain}
                  k3={1 - grain}
                  k4={0}
                />
              </filter>
            </defs>

            {/* Smooth gradient (bg + blurred shapes) wrapped in the grainy
                overlay filter -> css-tricks-style grainy gradient. */}
            <g filter="url(#grainyFilter)">
              <rect x={vbX} y={vbY} width={vbW} height={vbH} fill={bg} />
              <g filter="url(#blurFilter)">
                {shapes.map((s) =>
                  s.closed && s.anchors.length >= 2 ? (
                    <path key={s.id} d={pathD(s)} fill={s.color} />
                  ) : (
                    <path key={s.id} d={pathD(s)} fill="none" stroke={s.color} strokeWidth={4} />
                  ),
                )}
              </g>
            </g>

            {/* Editor overlay: invisible hit paths + anchors */}
            <g>
              {shapes.map((s) => (
                <g key={s.id}>
                  <path
                    d={pathD(s)}
                    fill={s.closed ? "transparent" : "none"}
                    stroke="transparent"
                    strokeWidth={20}
                    onMouseDown={(e) => {
                      if (tool === "select") {
                        e.stopPropagation();
                        setSelectedId(s.id);
                        if (e.metaKey || e.ctrlKey) {
                          const start = toSvg(e.clientX, e.clientY);
                          setDrag({
                            kind: "shape",
                            shapeId: s.id,
                            start,
                            origAnchors: s.anchors,
                          });
                        }
                      }
                    }}
                    onClick={(e) => onPathClick(e, s.id)}
                    onDoubleClick={(e) => onPathDblClick(e, s.id)}
                    style={{ cursor: tool === "select" ? "pointer" : "crosshair" }}
                  />
                  {/* Outline when selected */}
                  {selectedId === s.id && (
                    <path
                      d={pathD(s)}
                      fill="none"
                      stroke="white"
                      strokeOpacity={0.9}
                      strokeWidth={2}
                      strokeDasharray="6 6"
                      pointerEvents="none"
                    />
                  )}
                </g>
              ))}
              {/* Anchors and handles for selected shape */}
              {selected &&
                selected.anchors.map((a, i) => {
                  const isFirst = i === 0 && selected.id === draftId;
                  return (
                    <g key={i}>
                      {/* handle lines */}
                      <line
                        x1={a.p.x}
                        y1={a.p.y}
                        x2={a.hIn.x}
                        y2={a.hIn.y}
                        stroke="rgba(255,255,255,0.6)"
                        strokeWidth={1.5}
                      />
                      <line
                        x1={a.p.x}
                        y1={a.p.y}
                        x2={a.hOut.x}
                        y2={a.hOut.y}
                        stroke="rgba(255,255,255,0.6)"
                        strokeWidth={1.5}
                      />
                      {/* in handle */}
                      <circle
                        data-anchor-handle
                        cx={a.hIn.x}
                        cy={a.hIn.y}
                        r={6}
                        fill="#0ea5e9"
                        stroke="white"
                        strokeWidth={1.5}
                        style={{ cursor: "grab" }}
                        onMouseDown={(e) => onHandleMouseDown(e, selected.id, i, "in")}
                      />
                      {/* out handle */}
                      <circle
                        data-anchor-handle
                        cx={a.hOut.x}
                        cy={a.hOut.y}
                        r={6}
                        fill="#0ea5e9"
                        stroke="white"
                        strokeWidth={1.5}
                        style={{ cursor: "grab" }}
                        onMouseDown={(e) => onHandleMouseDown(e, selected.id, i, "out")}
                      />
                      {/* anchor */}
                      <rect
                        data-anchor-handle
                        data-first-anchor={isFirst ? selected.id : undefined}
                        x={a.p.x - 6}
                        y={a.p.y - 6}
                        width={12}
                        height={12}
                        fill={isFirst ? "#22c55e" : "white"}
                        stroke="#111"
                        strokeWidth={1.5}
                        style={{ cursor: "grab" }}
                        onMouseDown={(e) => onAnchorMouseDown(e, selected.id, i)}
                      />
                    </g>
                  );
                })}
            </g>
          </svg>

          {toast && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/80 text-white text-xs px-3 py-1.5 rounded-full">
              {toast}
            </div>
          )}
        </div>
      </main>

      {/* Right inspector */}
      <aside className="w-80 shrink-0 border-l border-white/10 overflow-y-auto p-4 space-y-5">
        <div>
          <h1 className="text-base font-medium">Grainy Gradient</h1>
          <p className="text-xs text-white/50">Wavy gradient maker</p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={onCopy}
            className="flex-1 bg-white text-black text-sm font-medium rounded-md py-2 hover:bg-white/90 transition-colors duration-200"
          >
            Copy PNG
          </button>
          <button
            onClick={onDownload}
            className="flex-1 bg-white/10 text-white text-sm font-medium rounded-md py-2 hover:bg-white/15 transition-colors duration-200"
          >
            Download
          </button>
        </div>

        <Section title="Canvas">
          <Row label="Background">
            <ColorInput value={bg} onChange={setBg} />
          </Row>
          <Row label="Blur">
            <Slider value={blur} min={0} max={300} onChange={setBlur} />
          </Row>
          <Row label="Grain">
            <Slider value={grain} min={0} max={1} step={0.01} onChange={setGrain} />
          </Row>
          <Row label="Grain scale">
            <Slider value={grainScale} min={0.4} max={6} step={0.1} onChange={setGrainScale} />
          </Row>
          <Row label="Proportions">
            <select
              value={propKey}
              onChange={(e) => {
                const next = e.target.value;
                setPropKey(next);
                setShapes(defaultShapesFor(next));
                setSelectedId(null);
                setDraftId(null);
              }}
              className="bg-white/5 text-white text-xs rounded px-2 py-1 border border-white/10"
            >
              {PROPORTIONS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Export size">
            <select
              value={exportSize}
              onChange={(e) => setExportSize(parseInt(e.target.value))}
              className="bg-white/5 text-white text-xs rounded px-2 py-1 border border-white/10"
            >
              {[600, 1000, 1500, 2400, 3000].map((w) => {
                const h = Math.round((w * vbH) / vbW);
                return (
                  <option key={w} value={w}>
                    {w} × {h}
                  </option>
                );
              })}
            </select>
          </Row>
        </Section>

        <Section title={`Selected shape${selected ? "" : " — none"}`}>
          {selected ? (
            <>
              <Row label="Color">
                <ColorInput
                  value={selected.color}
                  onChange={(v) => updateShape(selected.id, { color: v })}
                />
              </Row>
              <div className="flex gap-2">
                <button
                  className="flex-1 bg-white/5 hover:bg-white/10 transition-colors duration-200 text-xs rounded py-1.5 border border-white/10"
                  onClick={() => moveShape(selected.id, -1)}
                >
                  Send back
                </button>
                <button
                  className="flex-1 bg-white/5 hover:bg-white/10 transition-colors duration-200 text-xs rounded py-1.5 border border-white/10"
                  onClick={() => moveShape(selected.id, 1)}
                >
                  Bring fwd
                </button>
              </div>
              <button
                className="w-full bg-red-500/15 hover:bg-red-500/25 text-red-300 transition-colors duration-200 text-xs rounded py-1.5 border border-red-500/20"
                onClick={() => {
                  setShapes((prev) => prev.filter((s) => s.id !== selected.id));
                  setSelectedId(null);
                }}
              >
                Delete shape
              </button>
            </>
          ) : (
            <p className="text-xs text-white/40">Click a shape to edit it. Use the pen tool to draw new shapes.</p>
          )}
        </Section>

        <Section title="Layers">
          <ul className="space-y-1">
            {shapes
              .map((s, i) => ({ s, i }))
              .reverse()
              .map(({ s, i }) => (
                <li key={s.id}>
                  <button
                    onClick={() => setSelectedId((cur) => (cur === s.id ? null : s.id))}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors duration-200 ${
                      selectedId === s.id ? "bg-white/15" : "hover:bg-white/5"
                    }`}
                  >
                    <span
                      className="w-4 h-4 rounded-sm ring-1 ring-white/20"
                      style={{ background: s.color }}
                    />
                    <span className="flex-1 text-left">Shape {i + 1}</span>
                    <span className="text-white/30">{s.anchors.length}</span>
                  </button>
                </li>
              ))}
          </ul>
        </Section>

        <Section title="Tips">
          <ul className="text-xs text-white/50 space-y-1 list-disc pl-4">
            <li>Press <kbd className="bg-white/10 px-1 rounded">P</kbd> for pen, <kbd className="bg-white/10 px-1 rounded">V</kbd> for select.</li>
            <li>Click + drag with the pen to add a curved anchor.</li>
            <li>Click the green anchor (or press <kbd className="bg-white/10 px-1 rounded">Enter</kbd>) to close the shape.</li>
            <li>Double-click a shape to insert an anchor.</li>
            <li>Alt-click an anchor to delete it.</li>
            <li><kbd className="bg-white/10 px-1 rounded">Delete</kbd> removes the selected shape.</li>
          </ul>
        </Section>
      </aside>
    </>
  )}
  </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-wider text-white/40 mb-2">{title}</h2>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-white/60 shrink-0">{label}</span>
      <div className="flex-1 min-w-0 flex justify-end">{children}</div>
    </div>
  );
}

function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const norm = value.toUpperCase();
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-7 h-7 rounded cursor-pointer bg-transparent border border-white/10"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 bg-white/5 text-white text-xs rounded px-2 py-1 border border-white/10 font-mono"
        />
      </div>
      <div className="flex items-center gap-1">
        {BRAND_SWATCHES.map((s) => {
          const active = s.hex.toUpperCase() === norm;
          return (
            <button
              key={s.hex}
              type="button"
              title={`${s.name} — ${s.hex}`}
              onClick={() => onChange(s.hex)}
              className={`w-5 h-5 rounded-sm ring-1 transition-transform duration-200 hover:scale-110 ${
                active ? "ring-white ring-2" : "ring-white/20"
              }`}
              style={{ background: s.hex }}
            />
          );
        })}
      </div>
    </div>
  );
}

function Slider({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <div className="flex items-center gap-2 flex-1">
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 accent-white"
      />
      <span className="text-[10px] text-white/40 font-mono w-10 text-right">
        {Number.isInteger(value) ? value : value.toFixed(2)}
      </span>
    </div>
  );
}

function ToolBtn({
  children,
  onClick,
  active,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  label: string;
}) {
  return (
    <button
      title={label}
      onClick={onClick}
      className={`w-10 h-10 rounded-md flex items-center justify-center transition-colors duration-200 ${
        active ? "bg-white text-black" : "text-white/70 hover:bg-white/10"
      }`}
    >
      {children}
    </button>
  );
}
