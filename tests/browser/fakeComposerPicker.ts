/**
 * Minimal DOM for running the composer-picker page expressions in tests. It models the parts
 * of ChatGPT's current picker that the expressions depend on: a composer form, a trigger whose
 * aria-controls points at the open menu, a model submenu (which locks the effort slider while
 * open), an effort slider driven by arrow keys on its menu row, and Escape closing the picker.
 */

type Attributes = Record<string, string>;

export class FakeElement {
  readonly children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attached = true;
  private ownText = "";
  readonly listeners = new Map<string, Array<(event: { type: string; key?: string }) => void>>();

  constructor(
    readonly dom: FakePickerDom,
    readonly tagName: string,
    readonly attrs: Attributes = {},
    text = "",
  ) {
    this.ownText = text;
  }

  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
    return this;
  }

  /** Rendered text: block children (div, p) start their own line, inline spans join. */
  get innerText(): string {
    const parts = [this.ownText];
    for (const child of this.children) {
      parts.push(BLOCK_TAGS.has(child.tagName) ? `\n${child.innerText}\n` : child.innerText);
    }
    return parts.join("").replace(/\n+/g, "\n");
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.ownText = value;
    this.children.length = 0;
  }

  get isConnected(): boolean {
    return this.attached && (this.parent ? this.parent.isConnected : true);
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

  getBoundingClientRect(): { width: number; height: number } {
    const visible = this.isConnected && this.dom.isRendered(this);
    return visible ? { width: 100, height: 20 } : { width: 0, height: 0 };
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

  addEventListener(type: string, listener: (event: { type: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  dispatchEvent(event: { type: string; key?: string }): boolean {
    this.dom.events.push({ type: event.type, target: this });
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return true;
  }
}

const BLOCK_TAGS = new Set(["div", "p", "li"]);

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

export interface FakePickerOptions {
  /** Row title (split into inline spans when titleParts is set) plus an optional description line. */
  models?: Array<{ label: string; titleParts?: string[]; description?: string }>;
  checkedModel?: string | null;
  effort?: { min: string; max: string; value: string } | null;
  /** Key presses move the slider by this many steps (0 simulates an ignored key). */
  keyStep?: number;
  /** Trigger never exposes a bound menu (aria-controls points nowhere). */
  unboundMenu?: boolean;
  /** Clicking the target model row does not change the checked row. */
  modelClickIgnored?: boolean;
  /** Slider stays disabled even when the model submenu is closed. */
  sliderAlwaysDisabled?: boolean;
  /**
   * pill: connector chip outside the editor; chip: non-editable connector chip inside the editor;
   * prompt-link: only a link typed in the prompt; prompt-attribute: only an editable node carrying
   * the URI in an attribute; chip-and-link: chip plus a prompt link.
   */
  deepResearchToken?:
    | "pill"
    | "chip"
    | "prompt-link"
    | "prompt-attribute"
    | "chip-and-link"
    | "none";
  prompt?: string;
  /** Escape leaves the trigger expanded (stuck menu). */
  escapeIgnored?: boolean;
}

export class FakePickerDom {
  activeElement: FakeElement | null = null;
  readonly events: Array<{ type: string; target: FakeElement | "document" }> = [];
  readonly body: FakeElement;
  readonly form: FakeElement;
  readonly editor: FakeElement;
  readonly trigger: FakeElement;
  readonly menu: FakeElement;
  readonly subTrigger: FakeElement;
  readonly submenu: FakeElement;
  readonly modelItems: FakeElement[] = [];
  readonly sliderRow: FakeElement | null = null;
  readonly sliderContainer: FakeElement | null = null;
  readonly slider: FakeElement | null = null;
  readonly sendButton: FakeElement;
  menuOpen = false;
  submenuOpen = false;
  sentKeys: string[] = [];
  readonly portal: FakeElement;

  constructor(readonly options: FakePickerOptions = {}) {
    const el = (tag: string, attrs: Attributes = {}, text = "") =>
      new FakeElement(this, tag, attrs, text);
    this.body = el("body");
    this.form = el("form");
    this.editor = el(
      "div",
      { id: "prompt-textarea", contenteditable: "true", class: "ProseMirror" },
      options.prompt ?? "",
    );
    this.trigger = el(
      "button",
      {
        "aria-haspopup": "menu",
        "data-tone": "neutral",
        "aria-expanded": "false",
        "data-state": "closed",
      },
      "GPT-6 Pro",
    );
    this.sendButton = el("button", { "data-testid": "send-button" }, "Send");
    this.form.append(this.editor, this.trigger, this.sendButton);
    const token = "app://connector_openai_deep_research";
    const chipAttrs = { "data-id": `plugin:${token}`, "data-keyword": "Deep research" };
    const mode = options.deepResearchToken;
    if (mode === "pill") {
      this.form.append(el("span", chipAttrs, "Deep research"));
    }
    if (mode === "chip" || mode === "chip-and-link") {
      this.editor.append(el("span", { ...chipAttrs, contenteditable: "false" }, "Deep research"));
    }
    if (mode === "prompt-link" || mode === "chip-and-link") {
      this.editor.append(el("a", { href: token }, token));
    }
    if (mode === "prompt-attribute") {
      this.editor.append(el("span", { "data-id": `plugin:${token}` }, "typed"));
    }
    this.portal = el("div");
    this.menu = el("div", {
      id: "radix-menu",
      role: "menu",
      "data-testid": "composer-intelligence-picker-content",
    });
    this.subTrigger = el(
      "div",
      {
        role: "menuitem",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "data-state": "closed",
        "aria-controls": "radix-submenu",
      },
      options.checkedModel ?? "Model",
    );
    this.menu.append(this.subTrigger);
    if (options.effort !== null) {
      const effort = options.effort ?? { min: "0", max: "4", value: "2" };
      this.sliderRow = el("div", { role: "menuitem", tabindex: "-1" });
      this.sliderContainer = el("div", { "data-model-reasoning-effort-slider": "" });
      this.slider = el("input", {
        role: "slider",
        "aria-valuemin": effort.min,
        "aria-valuemax": effort.max,
        "aria-valuenow": effort.value,
      });
      this.sliderContainer.append(this.slider);
      this.sliderRow.append(this.sliderContainer);
      this.menu.append(this.sliderRow);
    }
    this.submenu = el("div", { id: "radix-submenu", role: "menu" });
    for (const model of options.models ?? [{ label: "GPT-6" }, { label: "GPT-5.6 Sol" }]) {
      const item = el("div", {
        role: "menuitemradio",
        "aria-checked": model.label === options.checkedModel ? "true" : "false",
      });
      for (const part of model.titleParts ?? [model.label]) item.append(el("span", {}, part));
      if (model.description) item.append(el("div", {}, model.description));
      item.addEventListener("click", () => this.clickModel(item, model.label));
      this.modelItems.push(item);
      this.submenu.append(item);
    }
    this.portal.append(this.menu, this.submenu);
    this.body.append(this.form, this.portal);
    this.trigger.addEventListener("pointerdown", () => this.toggleMenu());
    this.subTrigger.addEventListener("click", () => this.openSubmenu());
    this.syncSliderLock();
  }

  isRendered(node: FakeElement): boolean {
    if (this.menu.contains(node)) return this.menuOpen;
    if (this.submenu.contains(node)) return this.submenuOpen;
    if (node === this.portal) return true;
    // The real slider input is visually hidden; only its container renders.
    if (node === this.slider) return false;
    return true;
  }

  isFocusable(node: FakeElement): boolean {
    return node === this.editor || node === this.trigger || node === this.sliderRow;
  }

  toggleMenu(): void {
    // Like Radix, the trigger's own open state decides whether a press opens or closes.
    if (this.trigger.getAttribute("aria-expanded") === "true") {
      this.closeAll();
      return;
    }
    if (this.options.unboundMenu) {
      this.trigger.setAttribute("aria-expanded", "true");
      this.trigger.setAttribute("aria-controls", "missing-menu");
      return;
    }
    this.menuOpen = true;
    this.trigger.setAttribute("aria-expanded", "true");
    this.trigger.setAttribute("data-state", "open");
    this.trigger.setAttribute("aria-controls", "radix-menu");
    this.syncSliderLock();
  }

  openSubmenu(): void {
    if (!this.menuOpen) return;
    this.submenuOpen = true;
    this.subTrigger.setAttribute("aria-expanded", "true");
    this.subTrigger.setAttribute("data-state", "open");
    this.syncSliderLock();
  }

  closeAll(): void {
    if (this.options.escapeIgnored) return;
    this.menuOpen = false;
    this.submenuOpen = false;
    for (const node of [this.trigger, this.subTrigger]) {
      node.setAttribute("aria-expanded", "false");
      node.setAttribute("data-state", "closed");
    }
    this.trigger.removeAttribute("aria-controls");
    if (this.activeElement && !this.form.contains(this.activeElement)) this.activeElement = null;
    this.syncSliderLock();
  }

  clickModel(item: FakeElement, label: string): void {
    if (!this.options.modelClickIgnored) {
      for (const other of this.modelItems) other.setAttribute("aria-checked", "false");
      item.setAttribute("aria-checked", "true");
      this.subTrigger.textContent = label;
    }
    this.closeAll();
  }

  syncSliderLock(): void {
    if (!this.slider) return;
    if (this.submenuOpen || this.options.sliderAlwaysDisabled) {
      this.slider.setAttribute("aria-disabled", "true");
    } else {
      this.slider.removeAttribute("aria-disabled");
    }
  }

  get sliderValue(): number | null {
    const raw = this.slider?.getAttribute("aria-valuenow");
    return raw === null || raw === undefined ? null : Number(raw);
  }

  checkedModels(): string[] {
    return this.modelItems
      .filter((item) => item.getAttribute("aria-checked") === "true")
      .map((item) => item.innerText.split("\n")[0] ?? "");
  }

  /** CDP Input.dispatchKeyEvent stand-in: arrow keys move the slider when its row has focus. */
  pressKey(key: string): void {
    this.sentKeys.push(key);
    if (!this.slider || this.activeElement !== this.sliderRow || !this.menuOpen) return;
    if (this.slider.getAttribute("aria-disabled") === "true") return;
    const min = Number(this.slider.getAttribute("aria-valuemin"));
    const max = Number(this.slider.getAttribute("aria-valuemax"));
    const step = this.options.keyStep ?? 1;
    const current = this.sliderValue ?? 0;
    const next =
      key === "ArrowRight" ? current + step : key === "ArrowLeft" ? current - step : current;
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
      dispatchEvent: (event: { type: string; key?: string }) => {
        this.events.push({ type: event.type, target: "document" });
        if (event.type === "keydown" && event.key === "Escape") this.closeAll();
        return true;
      },
    };
    Object.defineProperty(facade, "activeElement", {
      get: () => this.activeElement ?? this.body,
    });
    return facade;
  }

  /** Evaluates a page expression against this DOM the way Runtime.evaluate would. */
  async evaluate(expression: string): Promise<unknown> {
    class FakeEvent {
      constructor(
        readonly type: string,
        readonly init: Record<string, unknown> = {},
      ) {}
      get key() {
        return this.init.key as string | undefined;
      }
    }
    let now = 0;
    const run = new Function(
      "document",
      "window",
      "performance",
      "setTimeout",
      "EventTarget",
      "MouseEvent",
      "PointerEvent",
      "KeyboardEvent",
      `return ${expression};`,
    );
    return await run(
      this.documentFacade(),
      { PointerEvent: FakeEvent },
      { now: () => (now += 50) },
      (handler: () => void) => {
        queueMicrotask(handler);
        return 0;
      },
      FakeElement,
      FakeEvent,
      FakeEvent,
      FakeEvent,
    );
  }

  /** Chrome-like Runtime/Input pair backed by this DOM. */
  cdp(): {
    Runtime: {
      evaluate: (params: { expression: string }) => Promise<{ result: { value: unknown } }>;
    };
    Input: { dispatchKeyEvent: (params: { type: string; key: string }) => Promise<void> };
  } {
    return {
      Runtime: {
        evaluate: async ({ expression }) => ({
          result: { value: await this.evaluate(expression) },
        }),
      },
      Input: {
        dispatchKeyEvent: async ({ type, key }) => {
          if (type === "rawKeyDown" || type === "keyDown") this.pressKey(key);
        },
      },
    };
  }
}
