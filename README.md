# static-render

A standalone build tool that pre-renders web components at build time. Your components make their real API calls during the static render, and the resulting HTML is served with fully rendered content — no loading spinners, no layout shift, no flash of empty content.

When the page loads in a browser, the component JavaScript takes over and refreshes the content dynamically.

## Requirements

- [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

## Install

```sh
git clone <repo-url>
cd static-render
bun install
```

The only dependency is [happy-dom](https://github.com/nicedayfor/happy-dom), used as a server-side DOM.

## Usage

```sh
bun run render.ts <input.html> <output.html>
```

If your components use `location.host`, `location.pathname`, or `location.href`, pass the target URL:

```sh
bun run render.ts --url https://example.com/page.html input.html output.html
```

## How it works

### Build time

1. Reads your HTML file and extracts local `<script src="...">` tags
2. Loads the script contents from disk and executes them in a [happy-dom](https://github.com/nicedayfor/happy-dom) window via Node's `vm` module — this registers your custom elements
3. Writes the HTML into the DOM, triggering custom element upgrades and `connectedCallback`
4. Your components make real `fetch()` calls and render their content
5. Waits for the DOM to settle (monitors mutations with a 500ms quiet period, 10s max timeout)
6. Serializes the rendered DOM:
   - **Shadow DOM** components are serialized using [Declarative Shadow DOM](https://developer.chrome.com/docs/css-ui/declarative-shadow-dom) (`<template shadowrootmode="open">`)
   - **Light DOM** components have their rendered children serialized inline, with a `data-static-rendered` attribute added to the element
7. Outputs a new HTML file with:
   - All pre-rendered content baked in
   - A small hydration shim script
   - The original component `<script>` tags (moved to end of `<body>`)

### Browser time

1. The browser parses the HTML and immediately displays the pre-rendered content — no JavaScript needed for the initial render
2. The hydration shim script runs, patching `CustomElementRegistry.prototype.define`
3. Your component scripts load and call `customElements.define()`
4. The browser upgrades the custom elements and calls `connectedCallback`
5. For **Shadow DOM** components: `attachShadow()` automatically replaces the declarative shadow root — no shim needed
6. For **Light DOM** components: the shim detects the `data-static-rendered` attribute, clears the pre-rendered content, then runs the original `connectedCallback` which fetches fresh data and re-renders
7. The `data-static-rendered` attribute is removed after hydration

### Why scripts are moved to end of `<body>`

The output places all `<script>` tags at the end of `<body>`, regardless of where they were in the input. This is necessary because when a custom element is already defined before the parser encounters it, the browser fires `connectedCallback` *before* parsing the element's children. Moving scripts after all content ensures the pre-rendered children are in the DOM when hydration runs.

## Examples

### Shadow DOM component

```html
<!-- input -->
<my-widget user-id="1"></my-widget>
```

```html
<!-- output -->
<my-widget user-id="1">
  <template shadowrootmode="open">
    <h2>Leanne Graham</h2>
    <p>Sincere@april.biz</p>
  </template>
</my-widget>
```

### Light DOM component

```html
<!-- input -->
<page-replies></page-replies>
```

```html
<!-- output -->
<page-replies data-static-rendered>
  <a href="mailto:...">Reply</a>
  <details>
    <summary>1 Replies</summary>
    <!-- ... rendered reply content ... -->
  </details>
</page-replies>
```

## Limitations

- **happy-dom compatibility**: Some browser APIs may not be available or may behave differently. Components that rely on layout calculations (`getBoundingClientRect`, `offsetWidth`, etc.) won't work at build time.
- **External scripts**: Only local `<script src="...">` tags are processed. Scripts loaded from CDNs (`https://...`) are left as-is and won't execute during the static render.
- **Relative script paths**: Script `src` paths are resolved relative to the input HTML file's directory.
- **`querySelector` with custom element names**: happy-dom has issues with selectors that use custom element tag names directly. Components that use standard CSS selectors internally work fine.
- **No `window.eval`**: Component scripts are executed via Node's `vm` module, not `eval`. This means scripts have access to DOM APIs and standard JS builtins, but not all `window` properties.

## Configuration

The tool uses two timing constants (defined at the top of `render.ts`):

- `QUIET_PERIOD` (default: 500ms) — how long the DOM must be unchanged before the render is considered complete
- `MAX_WAIT` (default: 10000ms) — maximum time to wait for the DOM to settle, regardless of mutations
