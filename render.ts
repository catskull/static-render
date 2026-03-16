#!/usr/bin/env bun

import { Window } from "happy-dom";
import { resolve, dirname, join } from "path";
import vm from "vm";

/**
 * Recursively strip namespace prefixes from element tag names (e.g. media:content → content).
 * Browsers do this when parsing XML via DOMParser, but happy-dom preserves them.
 */
function stripNamespacePrefixes(element: any) {
  if (element.tagName && element.tagName.includes(":")) {
    const localName = element.tagName.split(":")[1];
    // happy-dom stores tagName in upper/lower depending on context;
    // we need to rename the internal tag. Use replaceWith approach:
    // Create new element, copy attributes and children.
    const doc = element.ownerDocument;
    const replacement = doc.createElement(localName);
    for (const attr of [...element.attributes]) {
      replacement.setAttribute(attr.name, attr.value);
    }
    while (element.firstChild) {
      replacement.appendChild(element.firstChild);
    }
    element.replaceWith(replacement);
    element = replacement;
  }
  // Recurse into children (iterate copy since we may mutate)
  for (const child of [...element.childNodes]) {
    if (child.nodeType === 1) {
      stripNamespacePrefixes(child);
    }
  }
}

const QUIET_PERIOD = 500;
const MAX_WAIT = 10000;

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img",
  "input", "link", "meta", "param", "source", "track", "wbr",
]);

function serializeChildNodes(nodes: any): string {
  let html = "";
  for (const child of nodes) {
    if (child.nodeType === 3) {
      html += child.textContent;
    } else if (child.nodeType === 8) {
      html += `<!--${child.textContent}-->`;
    } else if (child.nodeType === 1) {
      html += serializeShadowRoots(child);
    }
  }
  return html;
}

function serializeShadowRoots(element: any): string {
  const tagName = element.tagName?.toLowerCase();
  if (!tagName) {
    return element.textContent ?? "";
  }

  let html = `<${tagName}`;
  if (element.attributes) {
    for (const attr of element.attributes) {
      html += ` ${attr.name}="${attr.value}"`;
    }
  }
  // Mark custom elements (names with hyphens) that have rendered light DOM content
  if (tagName.includes("-") && !element.shadowRoot && element.childNodes.length > 0) {
    html += ` data-static-rendered`;
  }
  html += ">";

  if (VOID_ELEMENTS.has(tagName)) {
    return html;
  }

  // Serialize shadow root as declarative shadow DOM
  if (element.shadowRoot) {
    html += `<template shadowrootmode="open">${serializeChildNodes(element.shadowRoot.childNodes)}</template>`;
  }

  html += serializeChildNodes(element.childNodes);
  html += `</${tagName}>`;
  return html;
}

function waitForSettled(window: any): Promise<void> {
  const document = window.document;
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => {
      observer.disconnect();
      resolve();
    }, MAX_WAIT);

    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        observer.disconnect();
        clearTimeout(timeout);
        resolve();
      }, QUIET_PERIOD);
    };

    const observer = new window.MutationObserver(() => {
      resetTimer();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    resetTimer();
  });
}

/**
 * Extract script sources from HTML and load their contents from disk.
 * Returns the scripts in order, plus the HTML with script tags stripped
 * (they'll be re-added in the output).
 */
async function extractScripts(html: string, baseDir: string) {
  const scriptPattern = /<script\s+([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi;

  const matches: { original: string; src: string }[] = [];
  for (const match of html.matchAll(scriptPattern)) {
    const [original, , src] = match;
    matches.push({ original, src });
  }

  // Read all script files in parallel (local from disk, remote via fetch)
  const isRemote = (src: string) => src.startsWith("http://") || src.startsWith("https://");
  const results = await Promise.all(
    matches.map(async ({ original, src }) => {
      try {
        const content = isRemote(src)
          ? await fetch(src).then((r) => r.text())
          : await Bun.file(join(baseDir, src)).text();
        return { src, content, original };
      } catch {
        console.warn(`Warning: could not load script ${src}, skipping`);
        return null;
      }
    })
  );
  const scripts = results.filter((s): s is NonNullable<typeof s> => s !== null);

  // Remove external script tags from HTML (they'll run via vm instead)
  let strippedHtml = html;
  for (const script of scripts) {
    strippedHtml = strippedHtml.replace(script.original, "");
  }

  return { scripts, strippedHtml };
}

async function render(inputPath: string, outputPath: string, url?: string) {
  const rawHtml = await Bun.file(inputPath).text();
  const baseDir = dirname(inputPath);

  const { scripts, strippedHtml } = await extractScripts(rawHtml, baseDir);

  const window = new Window({
    url: url || `file://${baseDir}/`,
    settings: {
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });

  try {
    // Patch missing JS builtins onto the happy-dom Window.
    // happy-dom's internals reference this.window.SyntaxError etc but don't define them.
    const missingOnWindow = [
      "SyntaxError", "TypeError", "RangeError", "Error", "URIError",
      "EvalError", "ReferenceError",
    ];
    for (const name of missingOnWindow) {
      if (!(window as any)[name]) {
        (window as any)[name] = (globalThis as any)[name];
      }
    }

    // Build a context with happy-dom DOM APIs only (not JS builtins like Date,
    // Array, etc). vm.runInNewContext provides its own JS builtins in the new
    // realm — injecting ours would break `new Date()` etc due to cross-realm issues.
    const domGlobals = [
      "document", "location", "navigator", "fetch", "console",
      "customElements", "HTMLElement", "Element", "Node", "Event",
      "CustomEvent", "MutationObserver", "setTimeout", "setInterval",
      "clearTimeout", "clearInterval", "addEventListener", "removeEventListener",
      "dispatchEvent", "getComputedStyle", "requestAnimationFrame",
      "cancelAnimationFrame", "atob", "btoa", "AbortController", "AbortSignal",
      "Headers", "Request", "Response", "URL", "URLSearchParams",
      "XMLHttpRequest", "FormData", "Blob", "File", "FileReader",
      "DOMParser", "NodeList", "HTMLCollection", "CSS",
    ];

    const context: Record<string, any> = {};
    for (const key of domGlobals) {
      try {
        const val = (window as any)[key];
        if (val !== undefined) context[key] = val;
      } catch {}
    }

    // Wrap DOMParser so XML namespace prefixes are stripped from tag names,
    // matching browser behavior (e.g. <media:content> becomes <content>).
    const OrigDOMParser = context.DOMParser;
    context.DOMParser = class extends OrigDOMParser {
      parseFromString(str: string, type: string) {
        const doc = super.parseFromString(str, type);
        if (type === "application/xml" || type === "text/xml") {
          stripNamespacePrefixes(doc.documentElement);
        }
        return doc;
      }
    };

    // 'window' and 'self' should reference the context itself
    context.window = context;
    context.self = context;

    // Execute component scripts in the combined context
    for (const script of scripts) {
      vm.runInNewContext(script.content, context);
    }

    // Now write the HTML — custom elements will upgrade and connectedCallback fires
    const document = window.document;
    document.write(strippedHtml);

    // Wait for all async operations (fetch calls, timers, etc.)
    await window.happyDOM.waitUntilComplete();

    // Wait for DOM mutations to settle
    await waitForSettled(window);

    // Serialize the full document with declarative shadow DOM
    const doctype = "<!DOCTYPE html>";
    let serialized = doctype + "\n" + serializeShadowRoots(document.documentElement);

    // Hydration shim — keeps pre-rendered content visible until new content is ready.
    //
    // Shadow DOM: patches attachShadow to return the existing declarative shadow root
    // instead of creating a new one. Pre-rendered content stays visible until the
    // component overwrites shadowRoot.innerHTML after its fetch completes.
    //
    // Light DOM: wraps pre-rendered children in a placeholder element, runs the
    // async connectedCallback (which appends new content), then removes the
    // placeholder once the callback resolves. No flash of empty content.
    const hydrationShim = `<script data-static-render="shim">(function(){` +
      // Shadow DOM: preserve declarative shadow root
      `var oA=HTMLElement.prototype.attachShadow;` +
      `HTMLElement.prototype.attachShadow=function(i){return this.shadowRoot||oA.call(this,i)};` +
      // Light DOM: wrap old content, swap after callback
      `var P=CustomElementRegistry.prototype,oD=P.define;` +
      `P.define=function(n,C){` +
        `var cc=C.prototype.connectedCallback;` +
        `if(cc){C.prototype.connectedCallback=function(){` +
          `var el=this,ph;` +
          `if(!el.shadowRoot&&el.hasAttribute("data-static-rendered")){` +
            `ph=document.createElement("static-render-ph");` +
            `while(el.firstChild)ph.appendChild(el.firstChild);` +
            `el.appendChild(ph);` +
            `el.removeAttribute("data-static-rendered")` +
          `}` +
          `var r=cc.apply(el,arguments);` +
          `if(ph){Promise.resolve(r).then(function(){ph.remove()})}` +
          `return r` +
        `}}` +
        `return oD.apply(this,arguments)` +
      `}})()</script>`;

    // Place scripts at end of <body> so all pre-rendered content is parsed
    // before elements upgrade. This ensures the shim can clear innerHTML
    // before connectedCallback runs.
    const bodyClose = serialized.lastIndexOf("</body>");
    if (bodyClose !== -1) {
      const scriptTags = scripts.map((s) => `  ${s.original}`).join("\n");
      serialized = serialized.slice(0, bodyClose) + `${hydrationShim}\n${scriptTags}\n` + serialized.slice(bodyClose);
    }

    await Bun.write(outputPath, serialized);
  } finally {
    await window.happyDOM.close();
  }
}

// CLI argument parsing
const args = Bun.argv.slice(2);
let url: string | undefined;
const positional: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url" && args[i + 1]) {
    url = args[++i];
  } else {
    positional.push(args[i]);
  }
}

const [inputPath, outputPath] = positional;

if (!inputPath || !outputPath) {
  console.error("Usage: static-render [--url <url>] <input.html> <output.html>");
  console.error("");
  console.error("Options:");
  console.error("  --url <url>  Set location.href for components that depend on it");
  process.exit(1);
}

const resolvedInput = resolve(process.cwd(), inputPath);
const resolvedOutput = resolve(process.cwd(), outputPath);

console.log(`Rendering ${resolvedInput} → ${resolvedOutput}`);
if (url) console.log(`  URL: ${url}`);
await render(resolvedInput, resolvedOutput, url);
console.log("Done.");
