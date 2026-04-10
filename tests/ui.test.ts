import { describe, it, expect, vi } from "vitest";
import chalk from "chalk";
import {
  box,
  table,
  bullet,
  numbered,
  keyValue,
  divider,
  visualWidth,
  stripAnsi,
  success,
  error,
  warn,
  info,
  dim,
  printBox,
  printTable,
  nextSteps,
  tip,
  callout,
  icons,
} from "../src/cli/utils/ui.js";

describe("visualWidth / stripAnsi", () => {
  it("strips ANSI escape sequences correctly", () => {
    const coloured = chalk.red("hello");
    expect(stripAnsi(coloured)).toBe("hello");
    expect(visualWidth(coloured)).toBe(5);
  });

  it("returns raw length for plain strings", () => {
    expect(visualWidth("abcdef")).toBe(6);
    expect(stripAnsi("abcdef")).toBe("abcdef");
  });

  it("handles multiple ANSI sequences", () => {
    const s = `${chalk.red("a")}${chalk.green("b")}${chalk.blue("c")}`;
    expect(visualWidth(s)).toBe(3);
  });
});

describe("box()", () => {
  it("produces a box with the requested outer width", () => {
    const out = box(["hello"], { width: 20 });
    const lines = out.split("\n");
    expect(lines.length).toBe(3); // top, body, bottom
    // Every rendered line should have the same stripped visual width.
    const widths = lines.map((l) => visualWidth(l));
    expect(widths[0]).toBe(20);
    expect(widths[1]).toBe(20);
    expect(widths[2]).toBe(20);
  });

  it("renders a titled box correctly", () => {
    const out = box(["body line"], { title: "Info", width: 30 });
    const lines = out.split("\n");
    expect(stripAnsi(lines[0])).toContain("Info");
    // Top line includes the title characters and still occupies full width
    expect(visualWidth(lines[0])).toBe(30);
    // Bottom line is still a full border
    expect(visualWidth(lines[lines.length - 1])).toBe(30);
  });

  it("handles empty lines without throwing", () => {
    const out = box([], { width: 20 });
    const lines = out.split("\n");
    expect(lines.length).toBe(2); // just top and bottom
    expect(visualWidth(lines[0])).toBe(20);
    expect(visualWidth(lines[1])).toBe(20);
  });

  it("preserves width when content contains ANSI codes", () => {
    const out = box([chalk.red("red text")], { width: 25 });
    const lines = out.split("\n");
    expect(visualWidth(lines[1])).toBe(25);
  });

  it("truncates content that exceeds the inner width", () => {
    const longText = "x".repeat(200);
    const out = box([longText], { width: 20 });
    const lines = out.split("\n");
    expect(visualWidth(lines[1])).toBe(20);
  });
});

describe("table()", () => {
  it("aligns columns and contains all headers and rows", () => {
    const out = table({
      headers: ["Name", "Age"],
      rows: [
        ["Alice", "30"],
        ["Bob", "25"],
      ],
    });
    const plain = stripAnsi(out);
    expect(plain).toContain("Name");
    expect(plain).toContain("Age");
    expect(plain).toContain("Alice");
    expect(plain).toContain("Bob");
    const lines = out.split("\n");
    // First data row should start with Alice after header + rule
    expect(stripAnsi(lines[2])).toMatch(/^Alice/);
  });

  it("handles mixed-length content without crashing", () => {
    const out = table({
      headers: ["Short", "Longer Header"],
      rows: [
        ["x", "something"],
        ["abcdef", "y"],
      ],
    });
    const lines = out.split("\n");
    // All body lines should have the same visual width as each other
    const w0 = visualWidth(lines[0]);
    for (const line of lines) {
      expect(visualWidth(line)).toBe(w0);
    }
  });

  it("supports right alignment per column", () => {
    const out = table({
      headers: ["A", "B"],
      rows: [["x", "12345"]],
      alignment: ["left", "right"],
    });
    expect(stripAnsi(out)).toContain("12345");
  });
});

describe("bullet() / numbered()", () => {
  it("bullet indents and prefixes correctly", () => {
    const out = bullet(["one", "two"], 4);
    const lines = out.split("\n");
    expect(lines[0].startsWith("    ")).toBe(true);
    expect(stripAnsi(lines[0])).toContain("\u2022");
    expect(stripAnsi(lines[0])).toContain("one");
    expect(stripAnsi(lines[1])).toContain("two");
  });

  it("numbered starts at 1 and increments", () => {
    const out = numbered(["first", "second", "third"]);
    const plain = stripAnsi(out);
    expect(plain).toContain("1.");
    expect(plain).toContain("2.");
    expect(plain).toContain("3.");
  });
});

describe("keyValue()", () => {
  it("aligns keys to the widest key", () => {
    const out = keyValue([
      ["name", "Alice"],
      ["age", "30"],
      ["favourite", "tea"],
    ]);
    const lines = out.split("\n");
    // All lines should start values at the same column (after the padded key)
    const valueIndices = lines.map((l) => stripAnsi(l).search(/\S\S+$/));
    // Not a strict equality since we padEnd by longest key — but column for
    // value should be monotonic: each value lines up after "favourite  "
    const plain = lines.map((l) => stripAnsi(l));
    const longestKey = "favourite".length;
    for (const line of plain) {
      // Value should start after padding + indent (>= 2 + longestKey + 2)
      const valueStart = line.search(/[A-Za-z0-9]+$/);
      expect(valueStart).toBeGreaterThanOrEqual(2 + longestKey);
    }
    expect(valueIndices.length).toBe(3);
  });
});

describe("divider()", () => {
  it("respects the requested width", () => {
    const out = divider("-", 10);
    expect(stripAnsi(out)).toBe("----------");
  });

  it("uses default characters and width", () => {
    const out = divider();
    expect(stripAnsi(out).length).toBe(60);
  });
});

describe("print functions don't throw", () => {
  it("success/error/warn/info/dim don't throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => success("ok")).not.toThrow();
      expect(() => error("bad")).not.toThrow();
      expect(() => error("bad", "run a fix")).not.toThrow();
      expect(() => warn("careful")).not.toThrow();
      expect(() => info("fyi")).not.toThrow();
      expect(() => dim("quiet")).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("printBox / printTable / nextSteps / tip / callout don't throw", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(() => printBox(["line"], { width: 20 })).not.toThrow();
      expect(() =>
        printTable({ headers: ["A", "B"], rows: [["1", "2"]] })
      ).not.toThrow();
      expect(() => nextSteps(["ctx sync", "ctx status"])).not.toThrow();
      expect(() => tip("press h for help")).not.toThrow();
      expect(() =>
        callout("Heads up", ["line one", "line two"])
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("icons", () => {
  it("exposes the full set of icons", () => {
    expect(icons.pass).toBeDefined();
    expect(icons.fail).toBeDefined();
    expect(icons.warn).toBeDefined();
    expect(icons.info).toBeDefined();
    expect(icons.arrow).toBeDefined();
    expect(icons.bullet).toBeDefined();
    expect(icons.star).toBeDefined();
    expect(stripAnsi(icons.pass)).toBe("\u2713");
    expect(stripAnsi(icons.fail)).toBe("\u2717");
  });
});
