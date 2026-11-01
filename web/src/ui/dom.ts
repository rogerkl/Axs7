type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown>;

/**
 * Creates an element. Attributes starting with "on" and given a function are event listeners, "class" is the
 * class name, properties of the element are set as properties, the rest as attributes.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[])
  : HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) {
      continue;
    }
    if (key === 'class') {
      e.className = String(value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      e.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in e) {
      Reflect.set(e, key, value);
    } else {
      e.setAttribute(key, String(value));
    }
  }
  append(e, children);
  return e;
}

export function append(parent: Element, children: Child[]): void {
  for (const c of children) {
    if (c !== null && c !== undefined && c !== false) {
      parent.append(typeof c === 'number' ? String(c) : c);
    }
  }
}

/** True while the user types in a field, so key presses aren't notes or data entry */
export function typing(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement;
}

export function download(bytes: Uint8Array, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h('a', { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Opens a file dialog */
export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...(input.files ?? [])]));
    input.click();
  });
}
