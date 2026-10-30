import { emitKeypressEvents } from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";

export interface Choice {
  label: string;
  hint?: string;
  checked: boolean;
}

/** Terminal checklist: arrows (or j/k) move, space toggles, a toggles all, enter saves. */
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
    const lines = [
      title,
      ...choices.map((c, i) => {
        const mark = options.single ? (i === cursor ? "●" : "○") : state[i] ? "◉" : "○";
        const pointer = i === cursor ? "›" : " ";
        return `${pointer} ${mark} ${c.label}${c.hint ? `  \x1b[2m${c.hint}\x1b[22m` : ""}`;
      }),
      `\x1b[2m${help}\x1b[22m`,
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
