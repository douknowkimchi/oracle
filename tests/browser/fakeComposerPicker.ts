/**
 * Minimal DOM that mirrors the composer observed on the product profile (CT125, 2026-11-13):
 * - form > ProseMirror editor (contenteditable) > p, "Add files and more", the model trigger
 *   `button[aria-label="Select ChatGPT model"][aria-haspopup="menu"]` and Send;
 * - one radix menu (bound through aria-controls) with `[data-model-picker-view]` simple/advanced:
 *   simple shows the view toggle and the Power row/slider while model rows stay covered;
 *   advanced makes the rows clickable and puts toggle/Power under inert + aria-hidden;
 * - a non-menu "Add files and more" list whose Deep Research item inserts an inline mention.
 * CDP input is simulated: mouse clicks hit the element at the point, keys go to the focus.
 */

type Attributes = Record<string, string>;
type TextNode = { nodeType: 3; textContent: string };

const TOKEN = "app://connector_openai_deep_research";

export class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attached = true;
  readonly nodeType = 1;
  ownText = "";
  readonly serial: number;

  constructor(
    readonly dom: FakePickerDom,
    readonly tagName: string,
    readonly attrs: Attributes = {},
    text = "",
  ) {
    this.ownText = text;
    this.serial = dom.nextSerial();
  }

  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }

  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  get childNodes(): Array<FakeElement | TextNode> {
    return [{ nodeType: 3, textContent: this.ownText }, ...this.children];
  }

  get isConnected(): boolean {
    return this.attached && (this.parent ? this.parent.isConnected : this === this.dom.body);
  }

  get disabled(): boolean {
    return "disabled" in this.attrs;
  }

  /** DOM-style attribute list, as read by `Array.from(node.attributes)`. */
  get attributes(): Array<{ name: string; value: string }> {
    return Object.entries(this.attrs).map(([name, value]) => ({ name, value }));
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }

  hasAttribute(name: string): boolean {
    return name in this.attrs;
  }

  removeAttribute(name: string): void {
    delete this.attrs[name];
  }

  /** Each rendered element gets its own 8x8 box so elementFromPoint can identify it. */
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    if (!this.isConnected || !this.dom.isRendered(this)) {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
    return { left: this.serial * 10, top: 100, width: 8, height: 8 };
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((node) => matchesSelector(node, selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  closest(selector: string): FakeElement | null {
    if (matchesSelector(this, selector)) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }

  contains(other: FakeElement | null): boolean {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }

  focus(): void {
    if (this.dom.isFocusable(this)) this.dom.activeElement = this;
  }
}

function matchesSelector(node: FakeElement, selector: string): boolean {
  return selector.split(",").some((part) => matchesCompound(node, part.trim()));
}

function matchesCompound(node: FakeElement, compound: string): boolean {
  if (compound === "*") return true;
  let rest = compound;
  const tag = /^[a-z][a-z0-9-]*/i.exec(rest);
  if (tag) {
    if (node.tagName.toLowerCase() !== tag[0].toLowerCase()) return false;
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let match: RegExpExecArray | null;
    if ((match = /^#([\w-]+)/.exec(rest))) {
      if (node.getAttribute("id") !== match[1]) return false;
    } else if ((match = /^\.([\w-]+)/.exec(rest))) {
      const classes = (node.getAttribute("class") ?? "").split(/\s+/);
      if (!classes.includes(match[1])) return false;
    } else if ((match = /^\[([\w-]+)(?:([*^]?=)"([^"]*)")?\]/.exec(rest))) {
      const value = node.getAttribute(match[1]);
      if (value === null) return false;
      if (match[2] === "=" && value !== match[3]) return false;
      if (match[2] === "*=" && !value.includes(match[3])) return false;
      if (match[2] === "^=" && !value.startsWith(match[3])) return false;
    } else if ((match = /^:not\((\[[^\]]+\])\)/.exec(rest))) {
      if (matchesCompound(node, match[1])) return false;
    } else {
      // Unsupported syntax (descendant combinators, :has, ...) never matches in this fake.
      return false;
    }
    rest = rest.slice(match[0].length);
  }
  return true;
}

export interface FakeModelRow {
  label: string;
  /** Title split into inline child spans inside the single title span. */
  titleParts?: string[];
  /** Extra span inside the row content block (a second "line"). */
  descriptionSpan?: string;
  /** Extra block outside the row content (text not covered by the title). */
  descriptionOutside?: string;
}

export interface FakePickerOptions {
  models?: FakeModelRow[];
  checkedModel?: string | null;
  effort?: { min: string; max: string; value: string } | null;
  /** Key presses move the slider by this many steps (0 simulates an ignored key). */
  keyStep?: number;
  /** Trigger opens but aria-controls names no element. */
  unboundMenu?: boolean;
  /** Model trigger is absent from the composer. */
  triggerMissing?: boolean;
  /** Clicking a model row does not change the checked row. */
  modelClickIgnored?: boolean;
  /** Observed: the menu stays open in the simple view; "close" covers a closing menu. */
  afterModelClick?: "simple" | "close";
  /** The menu reopens in the advanced view (unobserved; exercises the effort reopen path). */
  reopenInAdvanced?: boolean;
  /** Effort row locked even in the simple view (data-locked="true"). */
  sliderAlwaysDisabled?: boolean;
  /** Escape leaves the menu open. */
  escapeIgnored?: boolean;
  /** Prompt text already in the editor paragraph. */
  prompt?: string;
  /**
   * Deep Research state already in the editor: mention (observed), prompt-link (typed link),
   * editable-attribute (editable span with a mention attribute), arbitrary-attribute
   * (non-editable span with data-token), chip-child-editable (editable child of a chip),
   * mention-editable-child (editable child inside a mention carrying the attribute).
   */
  deepResearch?:
    | "none"
    | "mention"
    | "mention-and-link"
    | "prompt-link"
    | "editable-attribute"
    | "arbitrary-attribute"
    | "chip-child-editable"
    | "mention-editable-child";
  /** "Add files and more" list offers Deep Research (default true). */
  deepResearchOffered?: boolean;
}

export class FakePickerDom {
  activeElement: FakeElement | null = null;
  private serialCounter = 0;
  readonly body: FakeElement;
  readonly form: FakeElement;
  readonly editor: FakeElement;
  readonly paragraph: FakeElement;
  readonly addContext: FakeElement;
  readonly trigger: FakeElement;
  readonly sendButton: FakeElement;
  readonly menu: FakeElement;
  readonly viewNode: FakeElement;
  readonly simpleArea: FakeElement;
  readonly viewToggle: FakeElement;
  readonly powerRow: FakeElement | null = null;
  readonly slider: FakeElement | null = null;
  readonly lockNode: FakeElement | null = null;
  readonly modelRows: Array<{ row: FakeElement; label: string }> = [];
  readonly list: FakeElement;
  readonly listItem: FakeElement | null = null;
  menuOpen = false;
  listOpen = false;
  view: "simple" | "advanced" = "simple";
  private selectAllArmed = false;
  readonly sentKeys: string[] = [];
  readonly clicks: string[] = [];
  private readonly actions = new Map<FakeElement, () => void>();

  constructor(readonly options: FakePickerOptions = {}) {
    const el = (tag: string, attrs: Attributes = {}, text = "") =>
      new FakeElement(this, tag, attrs, text);
    this.body = el("body");
    this.form = el("form");
    this.editor = el("div", {
      class: "ProseMirror",
      role: "textbox",
      contenteditable: "true",
      "aria-label": "Ask ChatGPT",
    });
    this.paragraph = el("p", {}, options.prompt ?? "");
    this.editor.append(this.paragraph);
    this.addContext = el("button", {
      "aria-label": "Add files and more",
      "data-composer-navigation-target": "add-context",
      "data-state": "closed",
      "aria-expanded": "false",
    });
    this.trigger = el(
      "button",
      {
        "aria-label": "Select ChatGPT model",
        "aria-haspopup": "menu",
        "data-composer-navigation-target": "reasoning",
        "data-state": "closed",
        "aria-expanded": "false",
      },
      "Thinking effort Pro",
    );
    this.sendButton = el("button", { "aria-label": "Send" });
    this.form.append(this.editor, this.addContext);
    if (!options.triggerMissing) this.form.append(this.trigger);
    this.form.append(this.sendButton);

    this.menu = el("div", { id: "radix-menu", role: "menu", "data-state": "closed" });
    this.viewNode = el("div", { role: "group", "data-model-picker-view": "simple" });
    this.simpleArea = el("div");
    this.viewToggle = el(
      "div",
      { role: "menuitem", "aria-label": "Select model", "data-model-picker-view-toggle": "true" },
      "Select model",
    );
    this.simpleArea.append(this.viewToggle);
    if (options.effort !== null) {
      const effort = options.effort ?? { min: "0", max: "4", value: "2" };
      this.powerRow = el("div", {
        role: "menuitem",
        "aria-label": "Power",
        "data-reasoning-slider": "true",
        tabindex: "0",
      });
      this.lockNode = el("span", {
        "aria-disabled": options.sliderAlwaysDisabled ? "true" : "false",
        "data-locked": options.sliderAlwaysDisabled ? "true" : "false",
      });
      const sliderWrap = el("div", { "data-model-picker-power-slider": "" });
      this.slider = el("span", {
        role: "slider",
        "aria-valuemin": effort.min,
        "aria-valuemax": effort.max,
        "aria-valuenow": effort.value,
        tabindex: "-1",
      });
      sliderWrap.append(this.slider);
      this.lockNode.append(sliderWrap);
      this.powerRow.append(this.lockNode);
      this.simpleArea.append(this.powerRow);
    }
    this.viewNode.append(this.simpleArea);
    for (const model of options.models ?? [{ label: "GPT-6" }, { label: "GPT-5.6 Sol" }]) {
      const row = el("div", { role: "menuitemradio", "aria-checked": "false" });
      const content = el("div", { "data-menu-row-content": "true" });
      const title = el("span", {}, model.titleParts ? "" : model.label);
      for (const part of model.titleParts ?? []) title.append(el("span", {}, part));
      content.append(title);
      if (model.descriptionSpan !== undefined)
        content.append(el("span", {}, model.descriptionSpan));
      row.append(content);
      if (model.descriptionOutside !== undefined)
        row.append(el("div", {}, model.descriptionOutside));
      this.modelRows.push({ row, label: model.label });
      this.viewNode.append(row);
      this.actions.set(row, () => this.clickModel(row));
    }
    this.menu.append(this.viewNode);
    this.list = el("div", { class: "composer-list" });
    if (options.deepResearchOffered !== false) {
      this.listItem = el(
        "button",
        {
          type: "button",
          "data-list-navigation-item": "true",
          "data-plugin-impression-id": "connector_openai_deep_research",
        },
        "Deep research",
      );
      this.list.append(this.listItem);
      this.actions.set(this.listItem, () => this.insertMention());
    }
    this.body.append(this.form, this.menu, this.list);
    this.actions.set(this.trigger, () => this.toggleMenu());
    this.actions.set(this.viewToggle, () => this.showAdvanced());
    this.actions.set(this.addContext, () => this.toggleList());
    if (options.checkedModel) this.setChecked(options.checkedModel);
    this.insertDeepResearchState(options.deepResearch ?? "none");
  }

  nextSerial(): number {
    this.serialCounter += 1;
    return this.serialCounter;
  }

  isRendered(node: FakeElement): boolean {
    if (this.menu.contains(node)) return this.menuOpen;
    if (this.list.contains(node)) return this.listOpen && node !== this.list;
    if (node === this.list) return false;
    return true;
  }

  isFocusable(node: FakeElement): boolean {
    return node === this.editor || node === this.trigger || node === this.powerRow;
  }

  /** Topmost element at a point; model rows are covered by the Power row in the simple view. */
  elementFromPoint(x: number, y: number): FakeElement | null {
    const hit = [this.body, ...this.body.descendants()].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && x === rect.left + rect.width / 2 && y === rect.top + rect.height / 2;
    });
    if (!hit) return null;
    const row = this.modelRows.find(({ row: candidate }) => candidate.contains(hit));
    if (row && this.view === "simple") return this.powerRow ?? this.viewToggle;
    return hit;
  }

  /** Changes the checked row directly (as if the user changed it between checks). */
  setChecked(label: string): void {
    for (const { row, label: rowLabel } of this.modelRows) {
      const checked = rowLabel === label;
      row.setAttribute("aria-checked", checked ? "true" : "false");
      if (checked) row.setAttribute("data-model-selected", "true");
      else row.removeAttribute("data-model-selected");
    }
  }

  checkedModels(): string[] {
    return this.modelRows
      .filter(({ row }) => row.getAttribute("aria-checked") === "true")
      .map(({ label }) => label);
  }

  get sliderValue(): number | null {
    const raw = this.slider?.getAttribute("aria-valuenow");
    return raw === null || raw === undefined ? null : Number(raw);
  }

  toggleMenu(): void {
    if (this.trigger.getAttribute("aria-expanded") === "true") {
      this.closeMenu();
      return;
    }
    this.trigger.setAttribute("aria-expanded", "true");
    this.trigger.setAttribute("data-state", "open");
    if (this.options.unboundMenu) {
      this.trigger.setAttribute("aria-controls", "missing-menu");
      return;
    }
    this.trigger.setAttribute("aria-controls", "radix-menu");
    this.menuOpen = true;
    this.menu.setAttribute("data-state", "open");
    this.setView(this.options.reopenInAdvanced ? "advanced" : "simple");
  }

  showAdvanced(): void {
    if (this.view === "simple") this.setView("advanced");
  }

  private setView(view: "simple" | "advanced"): void {
    this.view = view;
    this.viewNode.setAttribute("data-model-picker-view", view);
    const locked = view === "advanced";
    for (const [name, value] of [
      ["inert", ""],
      ["aria-hidden", "true"],
    ] as const) {
      if (locked) this.simpleArea.setAttribute(name, value);
      else this.simpleArea.removeAttribute(name);
    }
    if (this.powerRow) {
      if (locked) {
        this.powerRow.setAttribute("aria-disabled", "true");
        this.powerRow.setAttribute("data-disabled", "");
      } else {
        this.powerRow.removeAttribute("aria-disabled");
        this.powerRow.removeAttribute("data-disabled");
      }
    }
  }

  closeMenu(): void {
    if (this.options.escapeIgnored) return;
    this.menuOpen = false;
    this.menu.setAttribute("data-state", "closed");
    this.trigger.setAttribute("aria-expanded", "false");
    this.trigger.setAttribute("data-state", "closed");
    this.trigger.removeAttribute("aria-controls");
    if (this.activeElement === this.powerRow) this.activeElement = this.editor;
  }

  private clickModel(row: FakeElement): void {
    if (this.view !== "advanced") return;
    const label = this.modelRows.find((entry) => entry.row === row)?.label;
    if (!this.options.modelClickIgnored && label) this.setChecked(label);
    if (this.options.afterModelClick === "close") this.closeMenu();
    else this.setView("simple");
  }

  toggleList(): void {
    this.listOpen = !this.listOpen;
    this.addContext.setAttribute("data-state", this.listOpen ? "open" : "closed");
    this.addContext.setAttribute("aria-expanded", this.listOpen ? "true" : "false");
  }

  private insertMention(): void {
    this.insertDeepResearchState("mention");
    this.toggleList();
  }

  private insertDeepResearchState(mode: NonNullable<FakePickerOptions["deepResearch"]>): void {
    const el = (tag: string, attrs: Attributes = {}, text = "") =>
      new FakeElement(this, tag, attrs, text);
    const mentionAttrs = {
      contenteditable: "false",
      "app-mention-path": TOKEN,
      "data-prompt-link-href": TOKEN,
      "data-appearance": "inline-mention",
    };
    const nodes: FakeElement[] = [];
    if (mode === "mention" || mode === "mention-and-link") {
      nodes.push(el("span", mentionAttrs).append(el("span", {}, "Deep research")));
    }
    if (mode === "prompt-link" || mode === "mention-and-link") {
      nodes.push(el("a", { href: TOKEN }, TOKEN));
    } else if (mode === "editable-attribute") {
      nodes.push(el("span", { "data-prompt-link-href": TOKEN }, "typed"));
    } else if (mode === "arbitrary-attribute") {
      nodes.push(el("span", { contenteditable: "false", "data-token": TOKEN }, "Deep research"));
    } else if (mode === "chip-child-editable") {
      nodes.push(
        el("span", { "data-id": "plugin:other" }).append(
          el("span", { contenteditable: "true", "data-token": TOKEN }, "child"),
        ),
      );
    } else if (mode === "mention-editable-child") {
      nodes.push(
        el("span", { contenteditable: "false", "data-appearance": "inline-mention" }).append(
          el("span", { contenteditable: "true", "app-mention-path": TOKEN }, "child"),
        ),
      );
    }
    if (nodes.length === 0) return;
    // The mention goes before the prompt text, like ChatGPT inserting it at the caret.
    const text = this.paragraph.ownText;
    this.paragraph.ownText = "";
    this.paragraph.append(...nodes, new FakeElement(this, "span", {}, ` ${text}`));
  }

  mentionPresent(): boolean {
    return this.editor
      .querySelectorAll("[app-mention-path]")
      .some((node) => node.getAttribute("contenteditable") === "false");
  }

  /** CDP Input.dispatchMouseEvent: a press+release at a point clicks the element there. */
  mouse(type: string, x: number, y: number): void {
    if (type !== "mouseReleased") return;
    const target = this.elementFromPoint(x, y);
    if (!target) return;
    let node: FakeElement | null = target;
    while (node && !this.actions.has(node)) node = node.parent;
    this.clicks.push(node?.getAttribute("aria-label") ?? node?.textContent ?? "(none)");
    if (node) this.actions.get(node)?.();
  }

  /** CDP Input.dispatchKeyEvent: keys go to the focused element. */
  key(type: string, key: string, modifiers = 0): void {
    if (type !== "rawKeyDown" && type !== "keyDown") return;
    this.sentKeys.push(modifiers ? `${key}+${modifiers}` : key);
    if (key === "Escape") {
      if (this.listOpen) this.toggleList();
      else if (this.menuOpen) this.closeMenu();
      return;
    }
    if (key === "a" && modifiers === 2 && this.activeElement === this.editor) {
      this.selectAllArmed = true;
      return;
    }
    if (key === "Backspace" && this.selectAllArmed && this.activeElement === this.editor) {
      this.paragraph.children.length = 0;
      this.paragraph.ownText = "";
      this.selectAllArmed = false;
      return;
    }
    if (key !== "ArrowRight" && key !== "ArrowLeft") return;
    if (!this.slider || !this.powerRow || this.activeElement !== this.powerRow || !this.menuOpen) {
      return;
    }
    if (this.powerRow.hasAttribute("aria-disabled") || this.options.sliderAlwaysDisabled) return;
    const min = Number(this.slider.getAttribute("aria-valuemin"));
    const max = Number(this.slider.getAttribute("aria-valuemax"));
    const step = this.options.keyStep ?? 1;
    const current = this.sliderValue ?? 0;
    const next = key === "ArrowRight" ? current + step : current - step;
    this.slider.setAttribute("aria-valuenow", String(Math.max(min, Math.min(max, next))));
  }

  /** Global document facade passed to page expressions. */
  documentFacade(): unknown {
    const facade = {
      activeElement: null as FakeElement | null,
      querySelectorAll: (selector: string) => this.body.querySelectorAll(selector),
      querySelector: (selector: string) => this.body.querySelector(selector),
      getElementById: (id: string) =>
        [this.body, ...this.body.descendants()].find((node) => node.getAttribute("id") === id) ??
        null,
      elementFromPoint: (x: number, y: number) => this.elementFromPoint(x, y),
    };
    Object.defineProperty(facade, "activeElement", {
      get: () => this.activeElement ?? this.body,
    });
    return facade;
  }

  /** Evaluates a page expression against this DOM the way Runtime.evaluate would. */
  async evaluate(expression: string): Promise<unknown> {
    const run = new Function("document", "window", `return ${expression};`);
    return await run(this.documentFacade(), {});
  }

  /** Chrome-like Runtime/Input pair backed by this DOM. */
  cdp() {
    return {
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => ({
          result: { value: await this.evaluate(expression) },
        }),
      },
      Input: {
        dispatchMouseEvent: async ({ type, x, y }: { type: string; x: number; y: number }) => {
          this.mouse(type, x, y);
        },
        dispatchKeyEvent: async ({
          type,
          key,
          modifiers,
        }: {
          type: string;
          key: string;
          modifiers?: number;
        }) => {
          this.key(type, key, modifiers ?? 0);
        },
        insertText: async ({ text }: { text: string }) => {
          this.paragraph.append(new FakeElement(this, "span", {}, text));
        },
      },
    };
  }
}
