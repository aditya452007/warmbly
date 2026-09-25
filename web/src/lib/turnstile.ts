// Compatibility shim for `react-turnstile` under Vite 8.
//
// react-turnstile@1.1.5 ships a CommonJS build with an "exports" map that
// defeats Vite 8's named-export detection in the dep optimizer. The optimizer
// therefore emits only `export default require_dist()`, and a default import
// resolves to the CJS *exports object* instead of the component — which React
// rejects at render time with "Minified error #130 ... got: object" (the
// login screen crashed on first paint because of this).
//
// This module resolves the component explicitly from whatever shape the
// bundler produced, so it works under dev, build, and any future Vite/rollup
// interop change:
//   - genuine ESM default export          → use it directly
//   - CJS exports object under `.default` → take `.default.Turnstile`
//   - synthetic named exports             → take `ns.Turnstile`
import * as mod from "react-turnstile";

type TurnstileComponent = (typeof import("react-turnstile"))["Turnstile"];

function resolveTurnstile(): TurnstileComponent {
    const ns = mod as unknown as {
        default?: unknown;
        Turnstile?: unknown;
    };

    if (typeof ns.default === "function") {
        // A real ESM default export.
        return ns.default as TurnstileComponent;
    }
    if (ns.default && typeof ns.default === "object") {
        // CJS interop: `default` is module.exports, the component lives on it.
        const cjs = ns.default as { Turnstile?: unknown };
        if (typeof cjs.Turnstile === "function") return cjs.Turnstile as TurnstileComponent;
    }
    if (typeof ns.Turnstile === "function") {
        // Synthetic named exports from the dep optimizer.
        return ns.Turnstile as TurnstileComponent;
    }
    throw new Error("react-turnstile: could not resolve the Turnstile component from the module shape the bundler produced");
}

export const Turnstile = resolveTurnstile();

// Convenience default export so callers can keep their original
// `import Turnstile from ...` style.
export default Turnstile;

export type { BoundTurnstileObject } from "react-turnstile";
