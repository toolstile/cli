import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

export interface Choice {
  label: string;
  hint?: string;
  checked: boolean;
}

/** Shortens text to `width` columns, keeping its end (the file name of a path). */
function fitStart(text: string, width: number) {
  return text.length <= width ? text : width < 2 ? "" : `…${text.slice(text.length - width + 1)}`;
}
const fitEnd = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;

/**
 * Terminal checklist: arrows (or j/k) move, space toggles, a toggles all, enter saves.
 * Every line is fitted to the terminal width: a wrapped line takes two rows, and the redraw
 * would then move up too few rows and leave copies of the title behind.
 */
export function checklist(
  title: string,
  choices: Choice[],
  input: ReadStream,
  output: WriteStream,
  options: { single?: boolean } = {},
): Promise<boolean[] | null> {
  const state = choices.map((c) => c.checked);
  let cursor = Math.max(0, options.single ? state.indexOf(true) : 0);
  let drawn = 0;
  const help = options.single ? "↑/↓ move · enter select · esc cancel" : "↑/↓ move · space toggle · a all · enter save · esc cancel";
  const render = () => {
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    // A spare column for glyphs some terminals draw double-width.
    const width = Math.max(20, (output.columns || 80) - 2);
    const lines = [
      fitEnd(title, width),
      ...choices.map((c, i) => {
        const mark = options.single ? (i === cursor ? "●" : "○") : state[i] ? "◉" : "○";
        const pointer = i === cursor ? "›" : " ";
        const text = fitEnd(`${pointer} ${mark} ${c.label}`, width);
        const room = width - text.length - 2;
        const hint = c.hint && room >= 8 ? `  \x1b[2m${fitStart(c.hint, room)}\x1b[22m` : "";
        return `${text}${hint}`;
      }),
      `\x1b[2m${fitEnd(help, width)}\x1b[22m`,
    ];
    output.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  return new Promise((resolve) => {
    emitKeypressEvents(input);
    const raw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    output.write("\x1b[?25l");
    const finish = (value: boolean[] | null) => {
      input.off("keypress", onKey);
      input.setRawMode(raw);
      input.pause();
      output.write("\x1b[?25h");
      resolve(value);
    };
    const onKey = (text: string | undefined, key: { name?: string; ctrl?: boolean } = {}) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape") return finish(null);
      if (key.name === "up" || text === "k") cursor = (cursor - 1 + choices.length) % choices.length;
      else if (key.name === "down" || text === "j") cursor = (cursor + 1) % choices.length;
      else if (!options.single && (key.name === "space" || text === " ")) state[cursor] = !state[cursor];
      else if (!options.single && text === "a") state.fill(!state.every(Boolean));
      else if (key.name === "return" || key.name === "enter")
        return finish(options.single ? choices.map((_, i) => i === cursor) : state);
      render();
    };
    input.on("keypress", onKey);
    render();
  });
}
