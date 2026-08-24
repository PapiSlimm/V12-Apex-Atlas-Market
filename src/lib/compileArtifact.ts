/**
 * JSX transpilation for the UI4A REPL harness.
 *
 * HISTORY
 * -------
 * The original harness passed raw JSX to `new Function`, which invokes the
 * JavaScript parser and therefore threw `SyntaxError: Unexpected token '<'` on
 * every single compile. That is fixed by actually transpiling first.
 *
 * This module now stops at transpilation. It deliberately does NOT execute
 * anything: the compiled source is handed to a sandboxed, opaque-origin iframe
 * (`SandboxedArtifact`) which owns execution. Keeping `new Function` out of the
 * app origin is what allows the application's CSP to drop `'unsafe-eval'`
 * entirely — the only document that can eval is the one with no cookies, no
 * storage, and no network.
 *
 * Babel is loaded lazily so it stays out of the initial bundle.
 */

type BabelStandalone = typeof import('@babel/standalone');

let babelPromise: Promise<BabelStandalone> | null = null;

function loadBabel(): Promise<BabelStandalone> {
  if (!babelPromise) babelPromise = import('@babel/standalone');
  return babelPromise;
}

/** Warm the transpiler ahead of first use so the first compile feels instant. */
export function preloadCompiler(): void {
  void loadBabel().catch(() => {
    /* preload is best-effort */
  });
}

const MAX_SOURCE_LENGTH = 60_000;

/**
 * The props parameter name used by the generated wrapper. Component bodies
 * address the injected payload as bare `data` — that is the documented contract
 * and what the system prompt tells the model to emit — so the wrapper
 * destructures it into scope.
 */
const PROPS_PARAM = '__apexProps';

export class ArtifactCompileError extends Error {
  constructor(
    message: string,
    readonly phase: 'normalise' | 'transpile',
  ) {
    super(message);
    this.name = 'ArtifactCompileError';
  }
}

/**
 * Models are inconsistent about what "a component" means. Accept the common
 * shapes and reduce them all to a bare function body.
 */
export function normaliseSource(raw: string): string {
  let code = (raw ?? '').trim();

  code = code.replace(/^```(?:tsx|jsx|ts|js|javascript)?\s*/i, '').replace(/```\s*$/, '');
  code = code.replace(/^\s*import\s+[^;\n]+;?\s*$/gm, '');
  code = code.replace(/^\s*export\s+default\s+/gm, '');
  code = code.replace(/^\s*export\s+/gm, '');
  code = code.trim();

  if (!code) throw new ArtifactCompileError('No component source provided.', 'normalise');
  if (code.length > MAX_SOURCE_LENGTH) {
    throw new ArtifactCompileError(
      `Component source is ${code.length} characters; the harness limit is ${MAX_SOURCE_LENGTH}.`,
      'normalise',
    );
  }

  const declMatch = code.match(/(?:function|const|let|var)\s+([A-Z][A-Za-z0-9_$]*)\s*[=(]/) ?? null;
  const hasTopLevelReturn = /^\s*return\s/m.test(code);

  // Shape A: a full component declaration — instantiate it and delegate.
  if (declMatch && !hasTopLevelReturn) return `${code}\nreturn ${declMatch[1]}(${PROPS_PARAM});`;

  // Shape B: a bare JSX expression with no `return`.
  if (!hasTopLevelReturn && /^\s*[(<]/.test(code)) {
    return `return (${code.replace(/;\s*$/, '')});`;
  }

  // Shape C: already a function body containing `return (...)`.
  return code;
}

/**
 * Transpile a JSX source string to a self-contained function declaration.
 *
 * The result declares `__ApexArtifact` and expects a `React` binding in scope;
 * the sandbox supplies it. Nothing is executed here.
 */
export async function transpileArtifact(source: string): Promise<string> {
  const body = normaliseSource(source);
  const babel = await loadBabel();

  const wrapped =
    `function __ApexArtifact(${PROPS_PARAM}) {\n` +
    `  var props = ${PROPS_PARAM} || {};\n` +
    `  var data = props.data;\n` +
    `${body}\n}`;

  try {
    const result = babel.transform(wrapped, {
      presets: [
        ['react', { runtime: 'classic', pragma: 'React.createElement', pragmaFrag: 'React.Fragment' }],
      ],
      sourceType: 'script',
      comments: false,
    });

    const code = result?.code ?? '';
    if (!code) throw new Error('Transpiler produced no output.');
    return code;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Babel's messages carry the offending line, which is what the user needs.
    throw new ArtifactCompileError(message.replace(/^unknown file:\s*/i, ''), 'transpile');
  }
}

/**
 * Collects the app's stylesheet text so the sandbox can render Tailwind classes.
 *
 * The sandbox has an opaque origin and `connect-src 'none'`, so it cannot fetch
 * the stylesheet itself — the parent has to hand it over. Cross-origin sheets
 * throw on `cssRules` access and are skipped.
 */
let cachedCss: string | null = null;

export function collectAppCss(): string {
  if (cachedCss !== null) return cachedCss;

  const chunks: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = (sheet as CSSStyleSheet).cssRules;
      if (!rules) continue;
      for (const rule of Array.from(rules)) chunks.push(rule.cssText);
    } catch {
      // Cross-origin stylesheet; nothing we can do and nothing we need.
    }
  }

  cachedCss = chunks.join('\n');
  return cachedCss;
}
